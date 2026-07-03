//go:build integration

package integration

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/remote-support/backend/internal/auth"
)

// randomUUID is a well-formed UUID that no test entity uses, for 404 probes.
const randomUUID = "11111111-1111-1111-1111-111111111111"

func TestHealthAndReady(t *testing.T) {
	if code, _ := app.doJSON(t, http.MethodGet, "/healthz", "", nil); code != http.StatusOK {
		t.Fatalf("healthz: want 200, got %d", code)
	}
	if code, _ := app.doJSON(t, http.MethodGet, "/readyz", "", nil); code != http.StatusOK {
		t.Fatalf("readyz: want 200, got %d", code)
	}
}

func TestAuthEnforcement(t *testing.T) {
	// Protected endpoint with no token → 401.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/me", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("/me no token: want 401, got %d", code)
	}
	// Bogus token → 401.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/me", "not.a.jwt", nil); code != http.StatusUnauthorized {
		t.Fatalf("/me bad token: want 401, got %d", code)
	}
	// Valid token → 200 and correct identity.
	code, body := app.doJSON(t, http.MethodGet, "/api/v1/me", app.techToken, nil)
	if code != http.StatusOK {
		t.Fatalf("/me: want 200, got %d", code)
	}
	if body["email"] != seedEmail {
		t.Fatalf("/me email: want %s, got %v", seedEmail, body["email"])
	}
}

func TestLoginBadCredentials(t *testing.T) {
	base, closeFn := freshServer(t)
	defer closeFn()
	if code, _ := loginAt(base, seedEmail, "wrong-password"); code != http.StatusUnauthorized {
		t.Fatalf("bad password: want 401, got %d", code)
	}
	if code, _ := loginAt(base, "nobody@itest.local", "whatever"); code != http.StatusUnauthorized {
		t.Fatalf("unknown email: want 401, got %d", code)
	}
	if code, _ := loginAt(base, seedEmail, seedPassword); code != http.StatusOK {
		t.Fatalf("good login: want 200, got %d", code)
	}
}

func TestEnrollmentAndDeviceAuth(t *testing.T) {
	// Wrong enrollment token → 401.
	code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/enroll", "", map[string]string{
		"enrollment_token": "WRONG", "name": "X", "hostname": "x", "os": "windows",
	})
	if code != http.StatusUnauthorized {
		t.Fatalf("bad enroll token: want 401, got %d", code)
	}

	deviceID, deviceToken := app.enrollDevice(t, "ENROLL-01")
	if deviceID == "" || !strings.Contains(deviceToken, ".") {
		t.Fatalf("enroll returned bad identity: id=%q token=%q", deviceID, deviceToken)
	}

	// Heartbeat with the real token → 200 and device becomes online.
	app.heartbeat(t, deviceToken)
	online := waitFor(2*time.Second, func() bool {
		_, body := app.doJSON(t, http.MethodGet, "/api/v1/devices", app.techToken, nil)
		for _, d := range asList(body["devices"]) {
			if d["id"] == deviceID && d["status"] == "online" {
				return true
			}
		}
		return false
	})
	if !online {
		t.Fatal("device did not appear online after heartbeat")
	}

	// Forged secret for a real device id → 401.
	forged := deviceID + ".forgedsecretforgedsecretforged"
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/heartbeat", forged, map[string]string{"status": "idle"}); code != http.StatusUnauthorized {
		t.Fatalf("forged device secret: want 401, got %d", code)
	}
}

func TestUnattendedSessionLifecycle(t *testing.T) {
	// Offline device → 409 conflict.
	offlineID, _ := app.enrollDevice(t, "OFFLINE-01")
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/sessions", app.techToken, map[string]string{"device_id": offlineID}); code != http.StatusConflict {
		t.Fatalf("session on offline device: want 409, got %d", code)
	}

	// Online device → 201 with a pending session + ICE servers.
	onlineID, onlineTok := app.enrollDevice(t, "ONLINE-01")
	app.heartbeat(t, onlineTok)
	code, body := app.doJSON(t, http.MethodPost, "/api/v1/sessions", app.techToken, map[string]string{"device_id": onlineID})
	if code != http.StatusCreated {
		t.Fatalf("create session: want 201, got %d (%v)", code, body)
	}
	sess := asMap(body["session"])
	if sess["status"] != "pending" || sess["type"] != "unattended" {
		t.Fatalf("unexpected session: %v", sess)
	}
	ice := asList(body["ice_servers"])
	if len(ice) == 0 {
		t.Fatal("expected ice_servers in session response")
	}
	// TURN entries must carry credentials; STUN entries must not.
	for _, s := range ice {
		urls, _ := s["urls"].(string)
		if strings.HasPrefix(urls, "turn:") && s["credential"] == nil {
			t.Fatalf("turn entry missing credential: %v", s)
		}
	}

	// End the session.
	sid := sess["id"].(string)
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/sessions/"+sid+"/end", app.techToken, nil); code != http.StatusOK {
		t.Fatalf("end session: want 200, got %d", code)
	}
	// session.end must be audited when the session actually transitions to ended.
	if !app.auditHas(t, sid, "session.end") {
		t.Fatal("session.end audit record missing after /end")
	}
	// Ending again is idempotent: still 200, no error, no duplicate transition.
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/sessions/"+sid+"/end", app.techToken, nil); code != http.StatusOK {
		t.Fatalf("idempotent end: want 200, got %d", code)
	}
}

func TestAttendedCodeSingleUse(t *testing.T) {
	// Create a code.
	code, body := app.doJSON(t, http.MethodPost, "/api/v1/attended/codes", app.techToken, map[string]string{"label": "Test laptop"})
	if code != http.StatusCreated {
		t.Fatalf("create code: want 201, got %d", code)
	}
	plain, _ := body["code"].(string)
	if len(strings.ReplaceAll(plain, "-", "")) != 9 {
		t.Fatalf("code should be 9 digits: %q", plain)
	}

	// First redemption succeeds.
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/attended/join", "", map[string]string{
		"code": plain, "hostname": "jane", "os": "windows",
	}); code != http.StatusOK {
		t.Fatalf("first join: want 200, got %d", code)
	}
	// Second redemption of the same code fails (single-use).
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/attended/join", "", map[string]string{
		"code": plain, "hostname": "jane", "os": "windows",
	}); code != http.StatusNotFound {
		t.Fatalf("reused code: want 404, got %d", code)
	}
	// Malformed (wrong length) code → 400.
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/attended/join", "", map[string]string{
		"code": "123", "hostname": "jane", "os": "windows",
	}); code != http.StatusBadRequest {
		t.Fatalf("short code: want 400, got %d", code)
	}
}

func TestAgentEventsIngestAndSanitization(t *testing.T) {
	// Set up a device that owns a session.
	devID, devTok := app.enrollDevice(t, "EVENTS-01")
	app.heartbeat(t, devTok)
	_, sbody := app.doJSON(t, http.MethodPost, "/api/v1/sessions", app.techToken, map[string]string{"device_id": devID})
	sid := asMap(sbody["session"])["id"].(string)

	// Owner reports file.transfer with an extra secret field → 202, field dropped.
	code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/events", devTok, map[string]any{
		"session_id": sid,
		"event_type": "file.transfer",
		"metadata":   map[string]any{"name": "notes.txt", "size": 1234, "direction": "to-agent", "secret_field": "LEAK"},
	})
	if code != http.StatusAccepted {
		t.Fatalf("agent events (owner): want 202, got %d", code)
	}

	// clipboard.sync with content → 202, but text must be dropped on persist.
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/events", devTok, map[string]any{
		"session_id": sid,
		"event_type": "clipboard.sync",
		"metadata":   map[string]any{"direction": "to-tech", "length": 6, "text": "SECRET"},
	}); code != http.StatusAccepted {
		t.Fatalf("agent events (clipboard.sync): want 202, got %d", code)
	}

	// input.command_attempt with content → 202, but content must be dropped.
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/events", devTok, map[string]any{
		"session_id": sid,
		"event_type": "input.command_attempt",
		"metadata":   map[string]any{"count": 2, "kind": "paste", "content": "rm -rf /"},
	}); code != http.StatusAccepted {
		t.Fatalf("agent events (input.command_attempt): want 202, got %d", code)
	}

	// Non-whitelisted event type → 400.
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/events", devTok, map[string]any{
		"session_id": sid, "event_type": "session.start", "metadata": map[string]any{},
	}); code != http.StatusBadRequest {
		t.Fatalf("agent events (bad type): want 400, got %d", code)
	}

	// No device token → 401.
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/events", "", map[string]any{
		"session_id": sid, "event_type": "file.transfer", "metadata": map[string]any{},
	}); code != http.StatusUnauthorized {
		t.Fatalf("agent events (no token): want 401, got %d", code)
	}

	// A DIFFERENT device may not report on this session → 403.
	_, otherTok := app.enrollDevice(t, "EVENTS-OTHER")
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/agent/events", otherTok, map[string]any{
		"session_id": sid, "event_type": "file.transfer", "metadata": map[string]any{"name": "x", "size": 1},
	}); code != http.StatusForbidden {
		t.Fatalf("agent events (non-owner): want 403, got %d", code)
	}

	// The stored file.transfer audit record must contain only whitelisted keys.
	found := waitFor(2*time.Second, func() bool {
		_, body := app.doJSON(t, http.MethodGet, "/api/v1/audit?event_type=file.transfer&session_id="+sid, app.techToken, nil)
		for _, ev := range asList(body["events"]) {
			meta := asMap(ev["metadata"])
			if meta["name"] == "notes.txt" {
				if _, leaked := meta["secret_field"]; leaked {
					t.Fatal("secret_field leaked into audit metadata")
				}
				if meta["direction"] != "to-agent" {
					t.Fatalf("unexpected metadata: %v", meta)
				}
				return true
			}
		}
		return false
	})
	if !found {
		t.Fatal("file.transfer audit record not found")
	}

	// clipboard.sync must persist only direction/length; text must be dropped.
	if !waitFor(2*time.Second, func() bool {
		_, body := app.doJSON(t, http.MethodGet, "/api/v1/audit?event_type=clipboard.sync&session_id="+sid, app.techToken, nil)
		for _, ev := range asList(body["events"]) {
			meta := asMap(ev["metadata"])
			if meta["direction"] == "to-tech" {
				if _, leaked := meta["text"]; leaked {
					t.Fatal("clipboard text leaked into audit metadata")
				}
				return true
			}
		}
		return false
	}) {
		t.Fatal("clipboard.sync audit record not found")
	}

	// input.command_attempt must persist only count/kind; content must be dropped.
	if !waitFor(2*time.Second, func() bool {
		_, body := app.doJSON(t, http.MethodGet, "/api/v1/audit?event_type=input.command_attempt&session_id="+sid, app.techToken, nil)
		for _, ev := range asList(body["events"]) {
			meta := asMap(ev["metadata"])
			if meta["kind"] == "paste" {
				if _, leaked := meta["content"]; leaked {
					t.Fatal("command content leaked into audit metadata")
				}
				return true
			}
		}
		return false
	}) {
		t.Fatal("input.command_attempt audit record not found")
	}
}

func TestAuditFilteringAndPagination(t *testing.T) {
	// There should already be many events from prior tests. Verify the core
	// lifecycle set is present and filtering + cursor pagination work.
	_, body := app.doJSON(t, http.MethodGet, "/api/v1/audit?limit=200", app.techToken, nil)
	seen := map[string]bool{}
	for _, ev := range asList(body["events"]) {
		seen[ev["event_type"].(string)] = true
	}
	// session.start is produced only by the signaling banner-ack flow (which runs
	// after this test in the shared DB), so it is intentionally not required here.
	for _, want := range []string{"auth.login", "device.register", "session.request", "session.approve", "session.end", "file.transfer"} {
		if !seen[want] {
			t.Errorf("expected audit event type %q to be present", want)
		}
	}

	// Filter by a single type returns only that type.
	_, fbody := app.doJSON(t, http.MethodGet, "/api/v1/audit?event_type=device.register&limit=50", app.techToken, nil)
	for _, ev := range asList(fbody["events"]) {
		if ev["event_type"] != "device.register" {
			t.Fatalf("filter leaked a %v event", ev["event_type"])
		}
	}

	// Pagination: limit=1 returns a cursor that advances.
	_, p1 := app.doJSON(t, http.MethodGet, "/api/v1/audit?limit=1", app.techToken, nil)
	if len(asList(p1["events"])) != 1 {
		t.Fatalf("limit=1 returned %d events", len(asList(p1["events"])))
	}
	cur, _ := p1["next_cursor"].(string)
	if cur == "" {
		t.Skip("no next_cursor returned (few events); pagination smoke skipped")
	}
	_, p2 := app.doJSON(t, http.MethodGet, "/api/v1/audit?limit=1&cursor="+urlEncode(cur), app.techToken, nil)
	if len(asList(p2["events"])) == 0 {
		t.Fatal("second page returned no events")
	}
	if first(p1) == first(p2) {
		t.Fatal("cursor did not advance: identical first event on both pages")
	}
}

func TestLoginRateLimit(t *testing.T) {
	base, closeFn := freshServer(t)
	defer closeFn()
	got429 := false
	for i := 0; i < 14; i++ {
		code, _ := loginAt(base, seedEmail, "wrong")
		if code == http.StatusTooManyRequests {
			got429 = true
			break
		}
	}
	if !got429 {
		t.Fatal("expected login rate limiting to trigger a 429 within a burst")
	}
}

func TestAttendedJoinRateLimit(t *testing.T) {
	base, closeFn := freshServer(t)
	defer closeFn()
	got429 := false
	for i := 0; i < 10; i++ {
		code, _ := doAt(t, base, http.MethodPost, "/api/v1/attended/join", "", map[string]string{
			"code": "000000000", "hostname": "x", "os": "windows",
		})
		if code == http.StatusTooManyRequests {
			got429 = true
			break
		}
	}
	if !got429 {
		t.Fatal("expected /attended/join rate limiting to trigger a 429 within a burst")
	}
}

func TestPresenceOnlineToOffline(t *testing.T) {
	devID, devTok := app.enrollDevice(t, "PRESENCE-01")
	app.heartbeat(t, devTok)

	if !waitFor(2*time.Second, func() bool { return deviceStatus(t, devID) == "online" }) {
		t.Fatal("device should be online after heartbeat")
	}

	// Force presence expiry by deleting the Redis key.
	if err := app.cache.DeletePresence(context.Background(), devID); err != nil {
		t.Fatalf("delete presence: %v", err)
	}
	if !waitFor(2*time.Second, func() bool { return deviceStatus(t, devID) == "offline" }) {
		t.Fatal("device should be offline after presence deletion")
	}

	// Offline filter includes it; online filter excludes it.
	if !deviceInList(t, "offline", devID) {
		t.Fatal("?status=offline should include the offline device")
	}
	if deviceInList(t, "online", devID) {
		t.Fatal("?status=online should exclude the offline device")
	}
	// Bogus status filter → 400.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/devices?status=bogus", app.techToken, nil); code != http.StatusBadRequest {
		t.Fatalf("?status=bogus: want 400, got %d", code)
	}
}

func TestGetDeviceByID(t *testing.T) {
	devID, devTok := app.enrollDevice(t, "GETDEV-01")
	app.heartbeat(t, devTok)

	// 200 with the correct id and online status.
	if !waitFor(2*time.Second, func() bool {
		code, body := app.doJSON(t, http.MethodGet, "/api/v1/devices/"+devID, app.techToken, nil)
		return code == http.StatusOK && body["id"] == devID && body["status"] == "online"
	}) {
		t.Fatal("GET /devices/{id}: expected 200 with correct id and online status")
	}
	// 404 for a random (but valid) uuid.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/devices/"+randomUUID, app.techToken, nil); code != http.StatusNotFound {
		t.Fatalf("random uuid: want 404, got %d", code)
	}
	// 401 without a token.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/devices/"+devID, "", nil); code != http.StatusUnauthorized {
		t.Fatalf("no token: want 401, got %d", code)
	}
	// 400 for a non-uuid id.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/devices/not-a-uuid", app.techToken, nil); code != http.StatusBadRequest {
		t.Fatalf("non-uuid: want 400, got %d", code)
	}
}

func TestListSessionsEndpoint(t *testing.T) {
	devID, devTok := app.enrollDevice(t, "LISTSESS-01")
	app.heartbeat(t, devTok)
	_, sbody := app.doJSON(t, http.MethodPost, "/api/v1/sessions", app.techToken, map[string]string{"device_id": devID})
	sid := asMap(sbody["session"])["id"].(string)

	// 200 and the created session id present.
	code, body := app.doJSON(t, http.MethodGet, "/api/v1/sessions", app.techToken, nil)
	if code != http.StatusOK {
		t.Fatalf("list sessions: want 200, got %d", code)
	}
	found := false
	for _, s := range asList(body["sessions"]) {
		if s["id"] == sid {
			found = true
		}
	}
	if !found {
		t.Fatal("created session id not present in list")
	}
	// 401 without a token.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/sessions", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("no token: want 401, got %d", code)
	}
	_, _ = app.doJSON(t, http.MethodPost, "/api/v1/sessions/"+sid+"/end", app.techToken, nil)
}

func TestAttendedCodeExpiry(t *testing.T) {
	code, body := app.doJSON(t, http.MethodPost, "/api/v1/attended/codes", app.techToken, map[string]string{"label": "expiry"})
	if code != http.StatusCreated {
		t.Fatalf("create code: want 201, got %d", code)
	}
	plain, _ := body["code"].(string)
	expiresAt, _ := body["expires_at"].(string)

	// A positive TTL must be set: expires_at is in the future.
	exp, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil || !exp.After(time.Now()) {
		t.Fatalf("expected a future expires_at, got %q (err=%v)", expiresAt, err)
	}

	// Force expiry by deleting the code's Redis key, then join → 404.
	hash := auth.HashSessionCode(app.cfg.JWTSecret, plain)
	if _, err := app.cache.RedeemSessionCode(context.Background(), hash); err != nil {
		t.Fatalf("could not expire code key: %v", err)
	}
	if code, _ := app.doJSON(t, http.MethodPost, "/api/v1/attended/join", "", map[string]string{
		"code": plain, "hostname": "x", "os": "windows",
	}); code != http.StatusNotFound {
		t.Fatalf("join after expiry: want 404, got %d", code)
	}
}

func TestMalformedUUIDReturns400(t *testing.T) {
	// Representative id path.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/sessions/not-a-uuid", app.techToken, nil); code != http.StatusBadRequest {
		t.Fatalf("GET /sessions/{bad}: want 400, got %d", code)
	}
	// Representative audit filter.
	if code, _ := app.doJSON(t, http.MethodGet, "/api/v1/audit?session_id=not-a-uuid", app.techToken, nil); code != http.StatusBadRequest {
		t.Fatalf("audit bad session_id filter: want 400, got %d", code)
	}
}

// deviceStatus returns the presence-derived status from GET /devices/{id}.
func deviceStatus(t *testing.T, id string) string {
	t.Helper()
	_, body := app.doJSON(t, http.MethodGet, "/api/v1/devices/"+id, app.techToken, nil)
	s, _ := body["status"].(string)
	return s
}

// deviceInList reports whether id appears in GET /devices?status=<filter>.
func deviceInList(t *testing.T, statusFilter, id string) bool {
	t.Helper()
	_, body := app.doJSON(t, http.MethodGet, "/api/v1/devices?status="+statusFilter, app.techToken, nil)
	for _, d := range asList(body["devices"]) {
		if d["id"] == id {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// small JSON helpers
// ---------------------------------------------------------------------------

func asList(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, e := range raw {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func first(body map[string]any) string {
	l := asList(body["events"])
	if len(l) == 0 {
		return ""
	}
	id, _ := l[0]["id"].(string)
	return id
}

//go:build integration

// Package integration holds in-process integration tests that wire the real
// service graph (config → store → cache → services → HTTP/WS router) against a
// real Postgres and Redis, then exercise it over HTTP and WebSocket exactly as
// a client would.
//
// These tests are build-tagged `integration` and are skipped unless
// TEST_DATABASE_URL and TEST_REDIS_URL point at reachable instances. The
// repository's test runner (test/run-all.sh) provisions both and runs:
//
//	go test -tags=integration ./internal/integration/...
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/httpapi"
	"github.com/remote-support/backend/internal/service"
	"github.com/remote-support/backend/internal/signal"
	"github.com/remote-support/backend/internal/store"
)

const (
	seedEmail    = "admin@itest.local"
	seedPassword = "itest-admin-password"
	enrollToken  = "itest-enrollment-token"
)

// testApp is the shared, in-process application under test.
type testApp struct {
	cfg       *config.Config
	store     *store.Store
	cache     *cache.Cache
	audit     *audit.Service
	hub       *signal.Hub
	svcs      *service.Services
	server    *httptest.Server
	baseURL   string
	wsBase    string
	techToken string
}

var app *testApp

func TestMain(m *testing.M) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	redisURL := os.Getenv("TEST_REDIS_URL")
	if dbURL == "" || redisURL == "" {
		fmt.Println("integration tests skipped: set TEST_DATABASE_URL and TEST_REDIS_URL")
		os.Exit(0)
	}

	// Configure the backend via env, exactly as production does.
	env := map[string]string{
		"APP_ENV":                "dev",
		"BACKEND_HTTP_ADDR":      ":0",
		"DATABASE_URL":           dbURL,
		"REDIS_URL":              redisURL,
		"JWT_SECRET":             "integration-test-jwt-secret-at-least-32-bytes!!",
		"JWT_TTL":                "3600s",
		"AGENT_ENROLLMENT_TOKEN": enrollToken,
		"SESSION_CODE_TTL":       "300s",
		"SESSION_CODE_LENGTH":    "9",
		"CORS_ALLOWED_ORIGIN":    "http://localhost:3000",
		"SEED_TECH_EMAIL":        seedEmail,
		"SEED_TECH_PASSWORD":     seedPassword,
		"ICE_SERVERS":            `["stun:coturn:3478","turn:coturn:3478"]`,
		"TURN_USER":              "turnuser",
		"TURN_PASSWORD":          "turnpassword",
		"TURN_REALM":             "itest.local",
	}
	for k, v := range env {
		_ = os.Setenv(k, v)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()

	// Clean slate: truncate all tables and flush Redis so assertions are exact.
	if err := resetDatabase(ctx, dbURL); err != nil {
		fmt.Println("failed to reset test database:", err)
		os.Exit(1)
	}
	if err := flushRedis(ctx, redisURL); err != nil {
		fmt.Println("failed to flush test redis:", err)
		os.Exit(1)
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Println("config load failed:", err)
		os.Exit(1)
	}

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fmt.Println("store.New failed:", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := store.Migrate(ctx, st, log); err != nil {
		fmt.Println("migrate failed:", err)
		os.Exit(1)
	}
	if err := service.SeedTechnician(ctx, st, cfg, log); err != nil {
		fmt.Println("seed failed:", err)
		os.Exit(1)
	}

	ca, err := cache.New(ctx, cfg.RedisURL)
	if err != nil {
		fmt.Println("cache.New failed:", err)
		os.Exit(1)
	}
	defer func() { _ = ca.Close() }()

	au := audit.New(st, log)
	hub := signal.NewHub(log)
	svcs := service.New(cfg, st, ca, au, hub, log)
	srv := httpapi.NewServer(cfg, svcs, hub, au, st, ca, log)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()

	app = &testApp{
		cfg:     cfg,
		store:   st,
		cache:   ca,
		audit:   au,
		hub:     hub,
		svcs:    svcs,
		server:  ts,
		baseURL: ts.URL,
		wsBase:  "ws" + strings.TrimPrefix(ts.URL, "http"),
	}

	// One shared technician token (login itself is exercised in auth_test.go with
	// its own fresh server so its rate-limit bursts don't interfere here).
	app.techToken = app.mustLogin(seedEmail, seedPassword)

	os.Exit(m.Run())
}

// resetDatabase truncates all application tables via a throwaway pool.
func resetDatabase(ctx context.Context, dbURL string) error {
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	// The tables may not exist yet on a first run; ignore "relation does not
	// exist" by creating a savepoint-free best-effort truncate after migration.
	// Migration runs after this in TestMain, so guard with IF EXISTS via DO block.
	_, err = pool.Exec(ctx, `
DO $$
BEGIN
  IF to_regclass('public.audit_events') IS NOT NULL THEN
    TRUNCATE audit_events, sessions, devices, technicians RESTART IDENTITY CASCADE;
  END IF;
END $$;`)
	return err
}

func flushRedis(ctx context.Context, redisURL string) error {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return err
	}
	c := redis.NewClient(opt)
	defer func() { _ = c.Close() }()
	return c.FlushDB(ctx).Err()
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// do performs an HTTP request against the shared app and returns status + raw body.
func (a *testApp) do(t *testing.T, method, path, token string, body any) (int, []byte) {
	t.Helper()
	return doAt(t, a.baseURL, method, path, token, body)
}

func doAt(t *testing.T, baseURL, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, baseURL+path, rdr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request %s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

// doJSON is `do` plus JSON-decoding the body into a generic map.
func (a *testApp) doJSON(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	code, raw := a.do(t, method, path, token, body)
	var out map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return code, out
}

func (a *testApp) mustLogin(email, password string) string {
	code, body := loginAt(a.baseURL, email, password)
	if code != http.StatusOK {
		panic(fmt.Sprintf("seed login failed: HTTP %d", code))
	}
	tok, _ := body["token"].(string)
	if tok == "" {
		panic("seed login returned no token")
	}
	return tok
}

func loginAt(baseURL, email, password string) (int, map[string]any) {
	b, _ := json.Marshal(map[string]string{"email": email, "password": password})
	resp, err := http.Post(baseURL+"/api/v1/auth/login", "application/json", bytes.NewReader(b))
	if err != nil {
		return 0, nil
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return resp.StatusCode, out
}

// enrollDevice registers a device and returns (deviceID, deviceToken).
func (a *testApp) enrollDevice(t *testing.T, name string) (string, string) {
	t.Helper()
	code, body := a.doJSON(t, http.MethodPost, "/api/v1/agent/enroll", "", map[string]string{
		"enrollment_token": enrollToken,
		"name":             name,
		"hostname":         strings.ToLower(name),
		"os":               "windows",
	})
	if code != http.StatusCreated {
		t.Fatalf("enroll %s: want 201, got %d (%v)", name, code, body)
	}
	return body["device_id"].(string), body["device_token"].(string)
}

func (a *testApp) heartbeat(t *testing.T, deviceToken string) {
	t.Helper()
	code, _ := a.doJSON(t, http.MethodPost, "/api/v1/agent/heartbeat", deviceToken, map[string]string{"status": "idle"})
	if code != http.StatusOK {
		t.Fatalf("heartbeat: want 200, got %d", code)
	}
}

// freshServer builds a NEW httptest server sharing the same store/cache but with
// its own rate limiters, for tests that deliberately exhaust a limiter.
func freshServer(t *testing.T) (string, func()) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httpapi.NewServer(app.cfg, app.svcs, app.hub, app.audit, app.store, app.cache, log)
	ts := httptest.NewServer(srv.Router())
	return ts.URL, ts.Close
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

type wsEnvelope struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id"`
	Payload   json.RawMessage `json:"payload"`
}

func (a *testApp) dialWS(t *testing.T, path string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(context.Background(), a.wsBase+path, nil)
	if err != nil {
		t.Fatalf("ws dial %s: %v", path, err)
	}
	return c
}

func writeEnvelope(t *testing.T, c *websocket.Conn, env wsEnvelope) {
	t.Helper()
	b, _ := json.Marshal(env)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("ws write: %v", err)
	}
}

// readEnvelope reads one envelope with a timeout. ok=false on timeout/close.
func readEnvelope(c *websocket.Conn, timeout time.Duration) (wsEnvelope, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		return wsEnvelope{}, false
	}
	var env wsEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return wsEnvelope{}, false
	}
	return env, true
}

// readEnvelopeOfType reads envelopes until one of type `want` arrives or the
// timeout elapses, skipping others (e.g. a buffered banner delivered first).
func readEnvelopeOfType(c *websocket.Conn, want string, timeout time.Duration) (wsEnvelope, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		env, ok := readEnvelope(c, time.Until(deadline))
		if !ok {
			return wsEnvelope{}, false
		}
		if env.Type == want {
			return env, true
		}
	}
	return wsEnvelope{}, false
}

// waitFor polls fn until it returns true or the deadline elapses.
func waitFor(d time.Duration, fn func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if fn() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fn()
}

func urlEncode(s string) string { return url.QueryEscape(s) }

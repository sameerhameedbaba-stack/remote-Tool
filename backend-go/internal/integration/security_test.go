//go:build integration

package integration

import (
	"net/http"
	"net/url"
	"testing"
)

// TestTokenRealmIsolation is the RBAC/authorization-boundary check for the MVP's
// two auth realms: a technician JWT and a device token are NOT interchangeable.
// A device token must be rejected on every technician route, and a technician
// JWT must be rejected on every device route. (Fine-grained admin-vs-technician
// RBAC is deferred in the single-tenant MVP; this locks in the realm boundary
// that exists today so a middleware regression can't silently cross it.)
func TestTokenRealmIsolation(t *testing.T) {
	_, deviceToken := app.enrollDevice(t, "REALM-01")

	// A device token on technician-only routes → 401.
	techRoutes := []struct {
		method, path string
	}{
		{http.MethodGet, "/api/v1/me"},
		{http.MethodGet, "/api/v1/devices"},
		{http.MethodGet, "/api/v1/sessions"},
		{http.MethodGet, "/api/v1/audit"},
		{http.MethodPost, "/api/v1/sessions"},
		{http.MethodPost, "/api/v1/attended/codes"},
	}
	for _, r := range techRoutes {
		if code, _ := app.doJSON(t, r.method, r.path, deviceToken, map[string]any{}); code != http.StatusUnauthorized {
			t.Fatalf("device token on %s %s: want 401, got %d", r.method, r.path, code)
		}
	}

	// A technician JWT on device-only routes → 401.
	deviceRoutes := []string{
		"/api/v1/agent/heartbeat",
		"/api/v1/agent/events",
	}
	for _, p := range deviceRoutes {
		if code, _ := app.doJSON(t, http.MethodPost, p, app.techToken, map[string]any{}); code != http.StatusUnauthorized {
			t.Fatalf("tech token on POST %s: want 401, got %d", p, code)
		}
	}
}

// TestDeviceSearchInjectionSafe proves the device-list `q` search is
// parameterized: classic SQL-injection payloads are treated as literal search
// text (200, no 500, table intact), not executed. Backstops the ILIKE query in
// store.ListDevices against a future refactor to string concatenation.
func TestDeviceSearchInjectionSafe(t *testing.T) {
	app.enrollDevice(t, "INJECT-CANARY")

	payloads := []string{
		"' OR '1'='1",
		"'; DROP TABLE devices; --",
		"%' UNION SELECT device_secret_hash FROM devices --",
		"\\",
	}
	for _, p := range payloads {
		path := "/api/v1/devices?q=" + url.QueryEscape(p)
		code, body := app.doJSON(t, http.MethodGet, path, app.techToken, nil)
		if code != http.StatusOK {
			t.Fatalf("search %q: want 200 (parameterized), got %d", p, code)
		}
		// A literal injection string matches no device name/hostname → empty list,
		// and crucially the query did not error or leak.
		if devs, ok := body["devices"].([]any); ok && len(devs) != 0 {
			t.Fatalf("search %q unexpectedly matched %d devices", p, len(devs))
		}
	}

	// The table survived (no DROP executed): the canary is still listable.
	code, body := app.doJSON(t, http.MethodGet, "/api/v1/devices?q="+url.QueryEscape("INJECT-CANARY"), app.techToken, nil)
	if code != http.StatusOK {
		t.Fatalf("post-injection list: want 200, got %d", code)
	}
	if devs, ok := body["devices"].([]any); !ok || len(devs) == 0 {
		t.Fatal("canary device missing after injection attempts — table integrity check failed")
	}
}

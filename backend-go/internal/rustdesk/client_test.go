package rustdesk

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDecodePeers_Shapes(t *testing.T) {
	cases := map[string]string{
		"bare array":   `[{"id":"123456789","hostname":"pc1","online":true}]`,
		"data wrap":    `{"data":[{"id":"123456789","hostname":"pc1","online":true}],"total":1}`,
		"peers wrap":   `{"peers":[{"guid":"123456789","hostname":"pc1","status":"online"}]}`,
		"status int":   `{"rows":[{"id":"123456789","hostname":"pc1","status":1}]}`,
		"status false": `{"data":[{"id":"123456789","hostname":"pc1","status":"offline"}]}`,
		// The real RustDesk Server Pro /api/devices shape (device_name + is_online).
		"rustdesk pro": `{"total":1,"data":[{"id":"123456789","device_name":"pc1","username":"Admin","os":"windows / Windows 11","is_online":true,"last_online":"2026-07-18T16:10:16"}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			wires, _, err := decodePeers([]byte(body))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if len(wires) != 1 {
				t.Fatalf("want 1 peer, got %d", len(wires))
			}
			p := wires[0].toPeer()
			if p.ID != "123456789" || p.Hostname != "pc1" {
				t.Fatalf("bad peer fields: %+v", p)
			}
			wantOnline := name != "status false"
			if p.Online != wantOnline {
				t.Fatalf("%s: online=%v want %v", name, p.Online, wantOnline)
			}
		})
	}
}

func TestNormalizeOS(t *testing.T) {
	cases := map[string]string{
		"windows / Windows 11 Home Single Language - 11 (26200)": "windows",
		"Mac OS X 14":  "macos",
		"Ubuntu Linux": "linux",
		"":             "",
	}
	for in, want := range cases {
		if got := normalizeOS(in); got != want {
			t.Fatalf("normalizeOS(%q) = %q want %q", in, got, want)
		}
	}
}

func TestEmptyObjectDecodesToNoPeers(t *testing.T) {
	// RustDesk returns a bare {} when the fleet is empty; must not error.
	wires, total, err := decodePeers([]byte(`{}`))
	if err != nil {
		t.Fatalf("decode {}: %v", err)
	}
	if len(wires) != 0 || total != 0 {
		t.Fatalf("want 0 peers/total, got %d/%d", len(wires), total)
	}
}

// Tenant isolation: a scoped technician must see ONLY exact-group matches;
// ungrouped and other-group machines are excluded. The admin (group "") sees
// all. This is the critical multi-tenant invariant.
func TestListPeers_ScopeExcludesUngroupedAndOtherGroups(t *testing.T) {
	body := `{"total":3,"data":[
		{"id":"111","device_name":"alice-pc","is_online":true,"group":"alice"},
		{"id":"999","device_name":"ungrouped-pc","is_online":true,"group":""},
		{"id":"888","device_name":"bob-pc","is_online":true,"group":"bob"}
	]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve the fixture on page 1, an empty page afterwards to end paging.
		if r.URL.Query().Get("current") == "1" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
			return
		}
		_, _ = w.Write([]byte(`{"total":3,"data":[]}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "tok")

	// Technician "alice" sees only her own machine — not ungrouped, not bob's.
	got, err := c.ListPeers(context.Background(), "alice")
	if err != nil {
		t.Fatalf("ListPeers(alice): %v", err)
	}
	if len(got) != 1 || got[0].ID != "111" {
		t.Fatalf("alice scope leak: %+v", got)
	}

	// Admin (empty group) sees all three.
	all, err := c.ListPeers(context.Background(), "")
	if err != nil {
		t.Fatalf("ListPeers(admin): %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("admin should see 3, got %d: %+v", len(all), all)
	}
}

func TestListPeers_NotConfigured(t *testing.T) {
	c := New("", "")
	if _, err := c.ListPeers(context.Background(), ""); err != ErrNotConfigured {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
}

func TestListPeers_AuthHeaderAndGroupFilter(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		// One peer in group "acme", one in "other": the client-side guard must drop "other".
		_, _ = w.Write([]byte(`{"data":[
			{"id":"111","hostname":"a","online":true,"group":"acme"},
			{"id":"222","hostname":"b","online":true,"group":"other"}
		]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-token")
	peers, err := c.ListPeers(context.Background(), "acme")
	if err != nil {
		t.Fatalf("ListPeers: %v", err)
	}
	if gotAuth != "Bearer secret-token" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if want := "/api/devices?current=1&pageSize=200"; gotPath != want {
		t.Fatalf("path = %q want %q", gotPath, want)
	}
	if len(peers) != 1 || peers[0].ID != "111" {
		t.Fatalf("group filter failed: %+v", peers)
	}
}

func TestDeleteDevice(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, "tok")
	if err := c.DeleteDevice(context.Background(), "384677266"); err != nil {
		t.Fatalf("DeleteDevice: %v", err)
	}
	if gotMethod != http.MethodDelete {
		t.Fatalf("method = %q want DELETE", gotMethod)
	}
	if gotPath != "/api/devices/384677266" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Fatalf("auth = %q", gotAuth)
	}
}

func TestDeleteDevice_NotConfigured(t *testing.T) {
	if err := New("", "").DeleteDevice(context.Background(), "x"); err != ErrNotConfigured {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
}

func TestListPeers_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(srv.URL, "bad")
	if _, err := c.ListPeers(context.Background(), ""); err == nil {
		t.Fatal("want error on 401")
	}
}

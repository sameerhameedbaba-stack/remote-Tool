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
			wires, err := decodePeers([]byte(body))
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
	wires, err := decodePeers([]byte(`{}`))
	if err != nil {
		t.Fatalf("decode {}: %v", err)
	}
	if len(wires) != 0 {
		t.Fatalf("want 0 peers, got %d", len(wires))
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
	if want := "/api/devices?current=1&pageSize=1000"; gotPath != want {
		t.Fatalf("path = %q want %q", gotPath, want)
	}
	if len(peers) != 1 || peers[0].ID != "111" {
		t.Fatalf("group filter failed: %+v", peers)
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

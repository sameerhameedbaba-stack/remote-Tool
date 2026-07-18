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
	if want := "/api/peers?pageSize=1000&group=acme"; gotPath != want {
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

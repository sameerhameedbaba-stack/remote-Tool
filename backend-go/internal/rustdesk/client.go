// Package rustdesk is a thin client for the RustDesk Server Pro admin API.
//
// RustDesk is the engine that actually moves pixels and input; this platform
// wraps it. The Pro server exposes a token-authenticated HTTP API under
// /api/... which we use to (a) list the devices/peers registered against the
// server and (b) report each one's online/offline status into the per-tenant
// panel — the "is this machine on?" view.
//
// The exact JSON shapes across RustDesk Pro versions vary; responses are decoded
// leniently (unknown fields ignored, both list-wrapped and bare-array shapes
// accepted) so a minor server upgrade does not break the panel. The endpoint
// path is configurable for the same reason.
package rustdesk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrNotConfigured is returned by callers when the RustDesk integration has no
// URL/token set. Handlers treat it as an empty fleet, not a hard failure.
var ErrNotConfigured = errors.New("rustdesk: API not configured")

// Client talks to a RustDesk Server Pro instance.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// New builds a client. baseURL is the console origin (e.g.
// http://200.97.171.196:21114) and token is a Pro API token. Either being empty
// yields a client whose calls return ErrNotConfigured.
func New(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

// Configured reports whether both a base URL and token are set.
func (c *Client) Configured() bool { return c.baseURL != "" && c.token != "" }

// Peer is one machine known to the RustDesk server.
type Peer struct {
	ID       string `json:"id"`       // RustDesk 9/10-digit device ID
	Hostname string `json:"hostname"` // reported OS hostname
	Username string `json:"username"` // OS user
	OS       string `json:"os"`       // platform string
	Online   bool   `json:"online"`   // derived from heartbeat/status
	LastSeen string `json:"last_seen,omitempty"`
	Group    string `json:"group,omitempty"` // Pro group / tenant tag
}

// peerWire tolerates the range of field names RustDesk Pro has used across
// versions (id vs guid, online vs status, os vs platform, etc.).
type peerWire struct {
	ID       string          `json:"id"`
	GUID     string          `json:"guid"`
	Hostname string          `json:"hostname"`
	Username string          `json:"username"`
	User     string          `json:"user"`
	OS       string          `json:"os"`
	Platform string          `json:"platform"`
	Online    *bool           `json:"online"`
	Status    json.RawMessage `json:"status"` // may be bool, "online", or 1/0
	LastOnline string         `json:"last_online"`
	LastSeen  string          `json:"last_seen"`
	Group     string          `json:"group"`
	GroupName string          `json:"group_name"`
	Tag       string          `json:"tag"`
}

func (w peerWire) toPeer() Peer {
	p := Peer{
		ID:       firstNonEmpty(w.ID, w.GUID),
		Hostname: w.Hostname,
		Username: firstNonEmpty(w.Username, w.User),
		OS:       firstNonEmpty(w.OS, w.Platform),
		LastSeen: firstNonEmpty(w.LastSeen, w.LastOnline),
		Group:    firstNonEmpty(w.Group, w.GroupName, w.Tag),
	}
	p.Online = interpretOnline(w.Online, w.Status)
	return p
}

// interpretOnline normalizes the several ways RustDesk Pro has encoded presence.
func interpretOnline(online *bool, status json.RawMessage) bool {
	if online != nil {
		return *online
	}
	s := strings.TrimSpace(strings.Trim(string(status), `"`))
	switch strings.ToLower(s) {
	case "1", "true", "online":
		return true
	default:
		return false
	}
}

// listWrap tolerates both {"data":[...]} / {"peers":[...]} and a bare [...].
type listWrap struct {
	Data  []peerWire `json:"data"`
	Peers []peerWire `json:"peers"`
	Rows  []peerWire `json:"rows"`
	Total int        `json:"total"`
}

// ListPeers returns every peer the server knows about. group, when non-empty,
// filters server-side (falling back to client-side filter if the server
// ignores it) so a tenant only sees its own machines.
func (c *Client) ListPeers(ctx context.Context, group string) ([]Peer, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	// /api/peers is the Pro device list; page size kept generous for small fleets.
	path := "/api/peers?pageSize=1000"
	if group != "" {
		path += "&group=" + group
	}
	body, err := c.get(ctx, path)
	if err != nil {
		return nil, err
	}

	wires, err := decodePeers(body)
	if err != nil {
		return nil, err
	}
	out := make([]Peer, 0, len(wires))
	for _, w := range wires {
		p := w.toPeer()
		if group != "" && p.Group != "" && !strings.EqualFold(p.Group, group) {
			continue // server ignored the filter; enforce it here
		}
		out = append(out, p)
	}
	return out, nil
}

// decodePeers accepts either a wrapped object or a bare array of peers.
func decodePeers(body []byte) ([]peerWire, error) {
	trimmed := strings.TrimSpace(string(body))
	if strings.HasPrefix(trimmed, "[") {
		var arr []peerWire
		if err := json.Unmarshal(body, &arr); err != nil {
			return nil, fmt.Errorf("rustdesk: decode peer array: %w", err)
		}
		return arr, nil
	}
	var w listWrap
	if err := json.Unmarshal(body, &w); err != nil {
		return nil, fmt.Errorf("rustdesk: decode peer object: %w", err)
	}
	switch {
	case len(w.Data) > 0:
		return w.Data, nil
	case len(w.Peers) > 0:
		return w.Peers, nil
	default:
		return w.Rows, nil
	}
}

func (c *Client) get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rustdesk: request %s: %w", path, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("rustdesk: read %s: %w", path, err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("rustdesk: %s unauthorized (check RUSTDESK_API_TOKEN)", path)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("rustdesk: %s returned %d: %s", path, resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

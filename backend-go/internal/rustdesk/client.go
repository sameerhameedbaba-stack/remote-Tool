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
	"net/url"
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
		// Interactive backstop: the fleet call sits on the dashboard's hot path,
		// so a hung RustDesk must not pin a request for long. Callers should also
		// pass a context deadline; this is the safety net if they don't.
		http: &http.Client{Timeout: 8 * time.Second},
	}
}

// Configured reports whether both a base URL and token are set.
func (c *Client) Configured() bool { return c.baseURL != "" && c.token != "" }

// Peer is one machine known to the RustDesk server.
type Peer struct {
	ID       string `json:"id"`       // RustDesk 9/10-digit device ID
	GUID     string `json:"guid"`     // internal unique id (used for delete)
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
	ID         string          `json:"id"`
	GUID       string          `json:"guid"`
	Hostname   string          `json:"hostname"`
	DeviceName string          `json:"device_name"` // RustDesk Pro /api/devices
	Alias      string          `json:"alias"`
	Username   string          `json:"username"`
	User       string          `json:"user"`
	OS         string          `json:"os"`
	Platform   string          `json:"platform"`
	Online     *bool           `json:"online"`
	IsOnline   *bool           `json:"is_online"` // RustDesk Pro /api/devices
	Status     json.RawMessage `json:"status"`    // may be bool, "online", or 1/0
	LastOnline string          `json:"last_online"`
	LastSeen   string          `json:"last_seen"`
	Group      string          `json:"group"`
	GroupName  string          `json:"group_name"`
	Tag        string          `json:"tag"`
}

func (w peerWire) toPeer() Peer {
	p := Peer{
		ID:       firstNonEmpty(w.ID, w.GUID),
		GUID:     w.GUID,
		Hostname: firstNonEmpty(w.DeviceName, w.Hostname, w.Alias),
		Username: firstNonEmpty(w.Username, w.User),
		OS:       normalizeOS(firstNonEmpty(w.OS, w.Platform)),
		LastSeen: firstNonEmpty(w.LastSeen, w.LastOnline),
		// Isolation key: only the authoritative group fields. A free-form,
		// user-settable "tag" must NOT decide cross-tenant visibility, so it is
		// deliberately excluded here (it may still be shown elsewhere as a label).
		Group: firstNonEmpty(w.Group, w.GroupName),
	}
	// Presence: RustDesk Pro /api/devices uses is_online; older shapes use
	// online or a status field. Take whichever is present.
	online := w.Online
	if online == nil {
		online = w.IsOnline
	}
	p.Online = interpretOnline(online, w.Status)
	return p
}

// normalizeOS collapses RustDesk's verbose platform string (e.g.
// "windows / Windows 11 Home Single Language - 11 (26200)") down to a simple
// token the console's OS icon understands.
func normalizeOS(s string) string {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "windows"):
		return "windows"
	case strings.Contains(l, "mac") || strings.Contains(l, "darwin") || strings.Contains(l, "osx"):
		return "macos"
	case strings.Contains(l, "linux"):
		return "linux"
	case strings.Contains(l, "android"):
		return "android"
	case strings.Contains(l, "ios"):
		return "ios"
	default:
		return l
	}
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

// pageSize is the per-request page for /api/devices; maxPages bounds the paging
// loop so a misbehaving server can never spin it forever (well above the Pro
// Basic device cap).
const (
	pageSize = 200
	maxPages = 100
)

// ListPeers returns the peers the server knows about, paginating so fleets
// larger than one page are not silently truncated.
//
// Tenant scope: when group is non-empty (a technician tenant), ONLY machines
// whose authoritative RustDesk group equals that value are returned — machines
// with a different group OR no group are excluded. The platform admin passes
// group == "" and receives the whole fleet. Filtering is client-side because
// the server-side filter param name is not stable across RustDesk versions.
func (c *Client) ListPeers(ctx context.Context, group string) ([]Peer, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	// RustDesk Server Pro's console API (Ant Design Pro style) lists machines at
	// /api/devices with current/pageSize paging. (/api/peers exists on some
	// versions but is 403 for console API tokens.)
	out := []Peer{}
	for page := 1; page <= maxPages; page++ {
		body, err := c.get(ctx, fmt.Sprintf("/api/devices?current=%d&pageSize=%d", page, pageSize))
		if err != nil {
			return nil, err
		}
		wires, total, err := decodePeers(body)
		if err != nil {
			return nil, err
		}
		if len(wires) == 0 {
			break
		}
		for _, w := range wires {
			p := w.toPeer()
			if p.ID == "" {
				continue // no usable RustDesk ID → cannot display or connect
			}
			if group != "" && !strings.EqualFold(p.Group, group) {
				continue // scoped tenant: exclude other-group and ungrouped machines
			}
			out = append(out, p)
		}
		// Done when the page was short or we've reached the server's reported total.
		if len(wires) < pageSize || (total > 0 && page*pageSize >= total) {
			break
		}
	}
	return out, nil
}

// decodePeers accepts either a wrapped object or a bare array of peers, and
// returns the server's reported total (0 when absent) for pagination.
func decodePeers(body []byte) ([]peerWire, int, error) {
	trimmed := strings.TrimSpace(string(body))
	if strings.HasPrefix(trimmed, "[") {
		var arr []peerWire
		if err := json.Unmarshal(body, &arr); err != nil {
			return nil, 0, fmt.Errorf("rustdesk: decode peer array: %w", err)
		}
		return arr, len(arr), nil
	}
	var w listWrap
	if err := json.Unmarshal(body, &w); err != nil {
		return nil, 0, fmt.Errorf("rustdesk: decode peer object: %w", err)
	}
	switch {
	case len(w.Data) > 0:
		return w.Data, w.Total, nil
	case len(w.Peers) > 0:
		return w.Peers, w.Total, nil
	default:
		return w.Rows, w.Total, nil
	}
}

// DeleteDevice removes a device from the RustDesk server (DELETE /api/devices/
// {id}). Best-effort: the machine re-registers if it later reconnects, so the
// platform also hides it locally. Returns ErrNotConfigured when the API is off.
func (c *Client) DeleteDevice(ctx context.Context, id string) error {
	if !c.Configured() {
		return ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		c.baseURL+"/api/devices/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("rustdesk: delete %s: %w", id, err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("rustdesk: delete %s returned %d", id, resp.StatusCode)
	}
	return nil
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

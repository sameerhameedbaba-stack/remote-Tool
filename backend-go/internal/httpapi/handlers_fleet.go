package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/service"
)

type fleetResponse struct {
	Members []service.FleetMember `json:"members"`
	Enabled bool                  `json:"enabled"`
	// Unavailable is true when RustDesk is configured but its API failed for
	// this request (down/slow/5xx). The panel shows a "temporarily unavailable"
	// hint instead of implying the fleet is empty.
	Unavailable bool `json:"unavailable"`
}

// fleetTimeout bounds the RustDesk call so a hung engine can't hold the request
// (and, on the frontend, the dashboard) for long.
const fleetTimeout = 6 * time.Second

// handleListFleet returns the RustDesk-managed machines visible to the caller.
// A technician is scoped to their own group (username); the platform admin sees
// the whole fleet. It NEVER hard-fails: RustDesk being unconfigured, down, or
// slow yields a 200 with an empty list (and unavailable=true on a real failure)
// so a secondary-integration hiccup can't take down the dashboard.
func (s *Server) handleListFleet(w http.ResponseWriter, r *http.Request) {
	claims := techFrom(r.Context())

	// Tenant isolation: non-admins only see machines in their own group; the
	// platform admin (empty group) sees the whole fleet.
	group := claims.Username
	if claims.Role == model.RoleAdmin {
		group = "" // whole fleet
	}

	ctx, cancel := context.WithTimeout(r.Context(), fleetTimeout)
	defer cancel()

	members, err := s.svcs.Fleet.ListForTechnician(ctx, group)
	if err != nil {
		// Degrade gracefully: log and report unavailable, never a 500.
		s.log.Warn("fleet unavailable", "err", err)
		writeJSON(w, http.StatusOK, fleetResponse{
			Members:     []service.FleetMember{},
			Enabled:     s.svcs.Fleet.Enabled(),
			Unavailable: true,
		})
		return
	}
	if members == nil {
		members = []service.FleetMember{}
	}
	writeJSON(w, http.StatusOK, fleetResponse{
		Members: members,
		Enabled: s.svcs.Fleet.Enabled(),
	})
}

// connectInfoResponse is the non-secret info the branded connect page and the
// downloaded client need to reach the RustDesk server. The server public key is
// public by design; the API token is never exposed here.
type connectInfoResponse struct {
	ServerID  string `json:"server_id"`
	PublicKey string `json:"public_key"`
	Enabled   bool   `json:"enabled"`
}

// handleConnectInfo is public (served on connect.<domain>): it lets the branded
// download page render the correct server and offer a manual-setup fallback.
func (s *Server) handleConnectInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, connectInfoResponse{
		ServerID:  s.cfg.RustDeskServerID,
		PublicKey: s.cfg.RustDeskPubKey,
		Enabled:   s.svcs.Fleet.Enabled(),
	})
}

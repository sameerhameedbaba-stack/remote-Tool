package httpapi

import (
	"net/http"

	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/service"
)

type fleetResponse struct {
	Members []service.FleetMember `json:"members"`
	Enabled bool                  `json:"enabled"`
}

// handleListFleet returns the RustDesk-managed machines visible to the caller.
// A technician is scoped to their own group (username); the platform admin sees
// the whole fleet. If RustDesk isn't configured yet, members is [] and enabled
// is false so the panel can show a "not connected" hint instead of an error.
func (s *Server) handleListFleet(w http.ResponseWriter, r *http.Request) {
	claims := techFrom(r.Context())

	// Tenant isolation: non-admins only see machines tagged with their username.
	group := claims.Username
	if claims.Role == model.RoleAdmin {
		group = "" // whole fleet
	}

	members, err := s.svcs.Fleet.ListForTechnician(r.Context(), group)
	if err != nil {
		writeServiceError(w, s.log, err)
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

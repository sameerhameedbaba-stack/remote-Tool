package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/service"
)

// handleTLSCheck is Caddy's on-demand-TLS "ask" endpoint: it returns 200 only
// for hostnames that should get a certificate (the apex, its fixed subdomains,
// and existing tenant subdomains), and 403 otherwise. Reachable only on the
// internal Docker network, so it needs no auth.
func (s *Server) handleTLSCheck(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	if domain == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if s.svcs.Admin.AllowTLSForHost(r.Context(), domain, s.cfg.PlatformDomain) {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusForbidden)
}

type createTechnicianRequest struct {
	Email       string `json:"email"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
}

// handleCreateTechnician (admin) provisions a new technician tenant.
func (s *Server) handleCreateTechnician(w http.ResponseWriter, r *http.Request) {
	var req createTechnicianRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	admin := techFrom(r.Context())
	tech, err := s.svcs.Admin.CreateTechnician(r.Context(), admin.Subject, service.TechnicianInput{
		Email:       req.Email,
		Username:    req.Username,
		DisplayName: req.DisplayName,
		Password:    req.Password,
	})
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusCreated, tech)
}

// handleListTechnicians (admin) lists the admin's technician tenants.
func (s *Server) handleListTechnicians(w http.ResponseWriter, r *http.Request) {
	admin := techFrom(r.Context())
	techs, err := s.svcs.Admin.ListTechnicians(r.Context(), admin.Subject, 200)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	if techs == nil {
		techs = []model.Technician{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"technicians": techs})
}

type setActiveRequest struct {
	Active bool `json:"active"`
}

// handleSetTechnicianActive (admin) enables/disables a technician.
func (s *Server) handleSetTechnicianActive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !parseUUIDParam(w, id, "id") {
		return
	}
	var req setActiveRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	admin := techFrom(r.Context())
	if err := s.svcs.Admin.SetTechnicianActive(r.Context(), admin.Subject, id, req.Active); err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

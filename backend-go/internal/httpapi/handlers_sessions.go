package httpapi

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/remote-support/backend/internal/model"
)

type createSessionRequest struct {
	DeviceID string `json:"device_id"`
}

type sessionWithICE struct {
	Session    *model.Session    `json:"session"`
	ICEServers []model.ICEServer `json:"ice_servers"`
}

type sessionsResponse struct {
	Sessions []model.Session `json:"sessions"`
}

// getSessionResponse embeds the session fields at the top level (preserving the
// existing bare-session GET shape) and additively includes ice_servers so a
// reloaded session tab can recover its relay credentials.
type getSessionResponse struct {
	*model.Session
	ICEServers []model.ICEServer `json:"ice_servers"`
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !parseUUIDParam(w, req.DeviceID, "device_id") {
		return
	}
	claims := techFrom(r.Context())
	sess, err := s.svcs.Session.CreateUnattended(r.Context(), claims.Subject, req.DeviceID, clientIP(r))
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusCreated, sessionWithICE{
		Session:    sess,
		ICEServers: nonNilICE(s.svcs.Session.ICEServers()),
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	if !validOptionalUUID(w, q.Get("device_id"), "device_id") {
		return
	}
	// Tenant isolation: a technician sees only their own sessions.
	claims := techFrom(r.Context())
	sessions, err := s.svcs.Session.List(r.Context(), claims.Subject, q.Get("status"), q.Get("device_id"), limit)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	if sessions == nil {
		sessions = []model.Session{}
	}
	writeJSON(w, http.StatusOK, sessionsResponse{Sessions: sessions})
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !parseUUIDParam(w, id, "id") {
		return
	}
	sess, err := s.svcs.Session.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, getSessionResponse{
		Session:    sess,
		ICEServers: nonNilICE(s.svcs.Session.ICEServers()),
	})
}

func (s *Server) handleEndSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !parseUUIDParam(w, id, "id") {
		return
	}
	claims := techFrom(r.Context())
	sess, err := s.svcs.Session.End(r.Context(), id, claims.Subject, clientIP(r))
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

// nonNilICE ensures ice_servers serializes as [] not null.
func nonNilICE(in []model.ICEServer) []model.ICEServer {
	if in == nil {
		return []model.ICEServer{}
	}
	return in
}

package httpapi

import (
	"net/http"

	"github.com/remote-support/backend/internal/model"
)

type createCodeRequest struct {
	Label string `json:"label"`
}

type createCodeResponse struct {
	Code      string `json:"code"`
	SessionID string `json:"session_id"`
	ExpiresAt string `json:"expires_at"`
}

func (s *Server) handleCreateCode(w http.ResponseWriter, r *http.Request) {
	var req createCodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	claims := techFrom(r.Context())
	res, err := s.svcs.Attended.CreateCode(r.Context(), claims.Subject, req.Label, clientIP(r))
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusCreated, createCodeResponse{
		Code:      res.Code,
		SessionID: res.SessionID,
		ExpiresAt: res.ExpiresAt.UTC().Format(rfc3339),
	})
}

type attendedJoinRequest struct {
	Code     string `json:"code"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
}

type attendedJoinResponse struct {
	SessionID   string            `json:"session_id"`
	DeviceToken string            `json:"device_token"`
	ICEServers  []model.ICEServer `json:"ice_servers"`
}

func (s *Server) handleAttendedJoin(w http.ResponseWriter, r *http.Request) {
	// Per-IP rate limit to blunt code brute-force.
	if !s.joinLimiter.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many join attempts")
		return
	}
	var req attendedJoinRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	res, err := s.svcs.Attended.Join(r.Context(), req.Code, req.Hostname, req.OS, clientIP(r))
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, attendedJoinResponse{
		SessionID:   res.SessionID,
		DeviceToken: res.DeviceToken,
		ICEServers:  nonNilICE(res.ICEServers),
	})
}

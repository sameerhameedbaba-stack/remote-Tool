package httpapi

import (
	"net/http"

	"github.com/remote-support/backend/internal/model"
)

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token      string            `json:"token"`
	ExpiresAt  string            `json:"expires_at"`
	Technician *model.Technician `json:"technician"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	// Per-IP rate limit to blunt online password spraying / enumeration.
	if !s.loginLimiter.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many login attempts")
		return
	}
	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	res, err := s.svcs.Auth.Login(r.Context(), req.Email, req.Password, clientIP(r))
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, loginResponse{
		Token:      res.Token,
		ExpiresAt:  res.ExpiresAt.UTC().Format(rfc3339),
		Technician: res.Technician,
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims := techFrom(r.Context())
	tech, err := s.svcs.Auth.GetTechnician(r.Context(), claims.Subject)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, tech)
}

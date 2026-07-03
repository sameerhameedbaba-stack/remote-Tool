package httpapi

import (
	"net/http"
)

type enrollRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	Name            string `json:"name"`
	Hostname        string `json:"hostname"`
	OS              string `json:"os"`
}

type enrollResponse struct {
	DeviceID            string `json:"device_id"`
	DeviceToken         string `json:"device_token"`
	PollIntervalSeconds int    `json:"poll_interval_seconds"`
}

func (s *Server) handleEnroll(w http.ResponseWriter, r *http.Request) {
	var req enrollRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	res, err := s.svcs.Agent.Enroll(r.Context(), req.EnrollmentToken, req.Name, req.Hostname, req.OS, clientIP(r))
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusCreated, enrollResponse{
		DeviceID:            res.DeviceID,
		DeviceToken:         res.DeviceToken,
		PollIntervalSeconds: 15,
	})
}

type heartbeatRequest struct {
	Status     string `json:"status"`
	AppVersion string `json:"app_version"`
}

type heartbeatResponse struct {
	OK                 bool `json:"ok"`
	PresenceTTLSeconds int  `json:"presence_ttl_seconds"`
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var req heartbeatRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	device := deviceFrom(r.Context())
	if err := s.svcs.Agent.Heartbeat(r.Context(), device, req.Status, req.AppVersion); err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, heartbeatResponse{
		OK:                 true,
		PresenceTTLSeconds: s.svcs.Agent.PresenceTTLSeconds(),
	})
}

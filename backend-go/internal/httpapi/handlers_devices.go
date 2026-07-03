package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/remote-support/backend/internal/model"
)

type devicesResponse struct {
	Devices []model.Device `json:"devices"`
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	statusFilter := r.URL.Query().Get("status")
	if statusFilter != "" && statusFilter != model.DeviceStatusOnline && statusFilter != model.DeviceStatusOffline {
		writeError(w, http.StatusBadRequest, "invalid_request", "status must be online or offline")
		return
	}
	q := r.URL.Query().Get("q")
	devices, err := s.svcs.Device.List(r.Context(), statusFilter, q)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, devicesResponse{Devices: devices})
}

func (s *Server) handleGetDevice(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	device, err := s.svcs.Device.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, device)
}

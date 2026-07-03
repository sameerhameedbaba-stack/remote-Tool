package httpapi

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
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
	limit := store.DefaultDeviceListLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	devices, err := s.svcs.Device.List(r.Context(), statusFilter, q, limit)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, devicesResponse{Devices: devices})
}

func (s *Server) handleGetDevice(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !parseUUIDParam(w, id, "id") {
		return
	}
	device, err := s.svcs.Device.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, device)
}

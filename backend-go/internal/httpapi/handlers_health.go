package httpapi

import (
	"context"
	"net/http"
	"time"
)

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := s.store.Ping(ctx); err != nil {
		s.log.Warn("readyz: db ping failed", "err", err)
		writeError(w, http.StatusServiceUnavailable, "internal", "database not ready")
		return
	}
	if err := s.cache.Ping(ctx); err != nil {
		s.log.Warn("readyz: redis ping failed", "err", err)
		writeError(w, http.StatusServiceUnavailable, "internal", "cache not ready")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

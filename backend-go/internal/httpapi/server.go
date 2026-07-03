// Package httpapi is the HTTP/WebSocket transport layer: routing, middleware,
// and handlers that translate between HTTP and the service layer.
package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/ratelimit"
	"github.com/remote-support/backend/internal/service"
	"github.com/remote-support/backend/internal/signal"
	"github.com/remote-support/backend/internal/store"
)

// rfc3339 is the timestamp format used in all responses.
const rfc3339 = time.RFC3339

// Server holds shared dependencies for the HTTP handlers.
type Server struct {
	cfg   *config.Config
	svcs  *service.Services
	hub   *signal.Hub
	audit *audit.Service
	store *store.Store
	cache *cache.Cache
	log   *slog.Logger

	joinLimiter *ratelimit.Limiter
}

// NewServer wires the transport layer.
func NewServer(cfg *config.Config, svcs *service.Services, hub *signal.Hub, au *audit.Service, st *store.Store, ca *cache.Cache, log *slog.Logger) *Server {
	return &Server{
		cfg:   cfg,
		svcs:  svcs,
		hub:   hub,
		audit: au,
		store: st,
		cache: ca,
		log:   log,
		// 5 join attempts burst, refilling at 1/sec per source IP.
		joinLimiter: ratelimit.New(1, 5),
	}
}

// Router builds the chi router with all routes and middleware.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Use(requestID)
	r.Use(recoverer(s.log))
	r.Use(requestLogger(s.log))
	r.Use(cors(s.cfg.CORSAllowedOrigin))

	// Public health.
	r.Get("/healthz", s.handleHealthz)
	r.Get("/readyz", s.handleReadyz)

	// WebSocket signaling (auth handled inside the handlers).
	r.Get("/ws/signal", s.handleSignalWS)
	r.Get("/ws/agent", s.handleAgentWS)

	r.Route("/api/v1", func(r chi.Router) {
		// Public endpoints.
		r.Post("/auth/login", s.handleLogin)
		r.Post("/agent/enroll", s.handleEnroll)
		r.Post("/attended/join", s.handleAttendedJoin)

		// Technician (JWT).
		r.Group(func(r chi.Router) {
			r.Use(s.requireTech)
			r.Get("/me", s.handleMe)
			r.Get("/devices", s.handleListDevices)
			r.Get("/devices/{id}", s.handleGetDevice)
			r.Post("/sessions", s.handleCreateSession)
			r.Get("/sessions", s.handleListSessions)
			r.Get("/sessions/{id}", s.handleGetSession)
			r.Post("/sessions/{id}/end", s.handleEndSession)
			r.Post("/attended/codes", s.handleCreateCode)
			r.Get("/audit", s.handleAudit)
		})

		// Agent/device (device token).
		r.Group(func(r chi.Router) {
			r.Use(s.requireDevice)
			r.Post("/agent/heartbeat", s.handleHeartbeat)
		})
	})

	return r
}

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

	joinLimiter   *ratelimit.Limiter
	loginLimiter  *ratelimit.Limiter
	enrollLimiter *ratelimit.Limiter
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
		// 10 login attempts burst, refilling at 0.5/sec per source IP: blunts
		// online password spraying and email-enumeration probing.
		loginLimiter: ratelimit.New(0.5, 10),
		// Mirror the login limiter for enrollment: blunts brute-forcing the shared
		// enrollment token per source IP.
		enrollLimiter: ratelimit.New(0.5, 10),
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

	// Caddy on-demand-TLS gate (internal network only).
	r.Get("/internal/tls-check", s.handleTLSCheck)

	// WebSocket signaling (auth handled inside the handlers).
	r.Get("/ws/signal", s.handleSignalWS)
	r.Get("/ws/agent", s.handleAgentWS)

	r.Route("/api/v1", func(r chi.Router) {
		// Public endpoints.
		r.Post("/auth/login", s.handleLogin)
		r.Post("/agent/enroll", s.handleEnroll)
		r.Post("/attended/join", s.handleAttendedJoin)
		r.Get("/connect/info", s.handleConnectInfo)
		r.Get("/connect/resolve", s.handleConnectResolve)
		r.Get("/connect/download", s.handleConnectDownload)
		r.Get("/connect/technician-app", s.handleTechnicianApp)

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
			r.Get("/fleet", s.handleListFleet)
			r.Post("/fleet/{id}/rename", s.handleRenameFleetMember)
			r.Post("/fleet/{id}/assign", s.handleAssignFleetMember)
			r.Delete("/fleet/{id}", s.handleDeleteFleetMember)
			r.Get("/audit", s.handleAudit)
		})

		// Platform super-admin (JWT + admin role): manage technician tenants.
		r.Group(func(r chi.Router) {
			r.Use(s.requireAdmin)
			r.Post("/admin/technicians", s.handleCreateTechnician)
			r.Get("/admin/technicians", s.handleListTechnicians)
			r.Post("/admin/technicians/{id}/active", s.handleSetTechnicianActive)
		})

		// Agent/device (device token).
		r.Group(func(r chi.Router) {
			r.Use(s.requireDevice)
			r.Post("/agent/heartbeat", s.handleHeartbeat)
			r.Post("/agent/events", s.handleAgentEvents)
		})
	})

	return r
}

// Package service holds the domain logic sitting between the HTTP handlers and
// the persistence/cache layers. Handlers translate HTTP<->service; services
// enforce the rules in docs/API.md and docs/SECURITY_MODEL.md.
package service

import (
	"log/slog"

	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/rustdesk"
	"github.com/remote-support/backend/internal/signal"
	"github.com/remote-support/backend/internal/store"
)

// Services aggregates the domain services.
type Services struct {
	Auth     *AuthService
	Admin    *AdminService
	Device   *DeviceService
	Session  *SessionService
	Attended *AttendedService
	Agent    *AgentService
	Fleet    *FleetService
}

// New wires the services with their shared dependencies.
func New(cfg *config.Config, st *store.Store, ca *cache.Cache, au *audit.Service, hub *signal.Hub, log *slog.Logger) *Services {
	return &Services{
		Auth:     &AuthService{cfg: cfg, store: st, audit: au, log: log},
		Admin:    &AdminService{store: st, audit: au, log: log},
		Device:   &DeviceService{store: st, cache: ca, log: log},
		Session:  &SessionService{cfg: cfg, store: st, cache: ca, audit: au, hub: hub, log: log},
		Attended: &AttendedService{cfg: cfg, store: st, cache: ca, audit: au, hub: hub, log: log},
		Agent:    &AgentService{cfg: cfg, store: st, cache: ca, audit: au, log: log},
		Fleet:    &FleetService{rd: rustdesk.New(cfg.RustDeskAPIURL, cfg.RustDeskAPIToken), store: st, log: log},
	}
}

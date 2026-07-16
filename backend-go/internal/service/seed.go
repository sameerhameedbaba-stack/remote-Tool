package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/remote-support/backend/internal/auth"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

// SeedTechnician creates the seed technician from SEED_TECH_EMAIL /
// SEED_TECH_PASSWORD if seeding is enabled and the technicians table is empty.
// It is idempotent and safe to call on every boot.
func SeedTechnician(ctx context.Context, st *store.Store, cfg *config.Config, log *slog.Logger) error {
	if !cfg.SeedEnabled() {
		return nil
	}
	n, err := st.CountTechnicians(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	hash, err := auth.HashPassword(cfg.SeedTechPassword)
	if err != nil {
		return err
	}
	tech := &model.Technician{
		ID:           uuid.NewString(),
		Email:        cfg.SeedTechEmail,
		Username:     "admin",
		PasswordHash: hash,
		DisplayName:  "Administrator",
		Role:         model.RoleAdmin,
		Active:       true,
		CreatedAt:    time.Now().UTC(),
	}
	if err := st.CreateTechnician(ctx, tech); err != nil {
		return err
	}
	log.Info("seeded technician", "email", cfg.SeedTechEmail, "id", tech.ID)
	return nil
}

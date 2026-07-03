package service

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/auth"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

// PollIntervalSeconds is advised to newly-enrolled agents.
const PollIntervalSeconds = 15

// AgentService owns device enrollment and heartbeat.
type AgentService struct {
	cfg   *config.Config
	store *store.Store
	cache *cache.Cache
	audit *audit.Service
	log   *slog.Logger
}

// EnrollResult is returned once at enrollment.
type EnrollResult struct {
	DeviceID    string
	DeviceToken string
}

// Enroll registers a new unattended device after validating the shared
// enrollment token in constant time. Writes device.register.
func (s *AgentService) Enroll(ctx context.Context, enrollmentToken, name, hostname, os, ip string) (*EnrollResult, error) {
	if subtle.ConstantTimeCompare([]byte(enrollmentToken), []byte(s.cfg.AgentEnrollmentToken)) != 1 {
		return nil, ErrUnauthorized
	}

	secret, hash, err := auth.NewDeviceSecret()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	device := &model.Device{
		ID:               uuid.NewString(),
		Name:             name,
		Hostname:         hostname,
		OS:               os,
		DeviceSecretHash: hash,
		Mode:             model.DeviceModeUnattended,
		CreatedAt:        now,
	}
	if err := s.store.CreateDevice(ctx, device); err != nil {
		return nil, err
	}

	if err := s.audit.Record(ctx, audit.Entry{
		EventType: audit.EventDeviceRegister,
		DeviceID:  audit.Ptr(device.ID),
		Metadata:  map[string]any{"name": name, "hostname": hostname, "os": os, "ip": ip},
	}); err != nil {
		return nil, err
	}

	return &EnrollResult{
		DeviceID:    device.ID,
		DeviceToken: auth.FormatDeviceToken(device.ID, secret),
	}, nil
}

// Heartbeat refreshes the device presence key (TTL 30s) and last_seen_at.
func (s *AgentService) Heartbeat(ctx context.Context, device *model.Device, status, appVersion string) error {
	if status == "" {
		status = "idle"
	}
	if err := s.cache.SetPresence(ctx, device.ID, status); err != nil {
		return err
	}
	if err := s.store.UpdateLastSeen(ctx, device.ID, time.Now().UTC(), appVersion); err != nil {
		return err
	}
	return nil
}

// PresenceTTLSeconds is the presence key TTL reported to agents.
func (s *AgentService) PresenceTTLSeconds() int {
	return int(cache.PresenceTTL / time.Second)
}

// OpenSessionForDevice returns the device's current pending/active session, or
// nil if none. Used by the agent WS handler to (re)issue session-control:start.
func (s *AgentService) OpenSessionForDevice(ctx context.Context, deviceID string) (*model.Session, error) {
	sess, err := s.store.GetOpenSessionForDevice(ctx, deviceID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return sess, nil
}

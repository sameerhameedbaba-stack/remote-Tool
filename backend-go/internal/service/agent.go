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

// allowedAgentEventTypes is the closed subset of audit events an agent may
// report from its peer-to-peer data channels (see docs/API.md).
var allowedAgentEventTypes = map[string]bool{
	audit.EventFileTransfer:    true,
	audit.EventClipboardSync:   true,
	audit.EventInputCommandTry: true,
}

// ReportEvent records a data-channel audit event reported by an agent for a
// session it is a party to. Only the closed data-channel subset is accepted,
// the device must own the session, and only non-content metadata is persisted
// (never clipboard text or keystroke contents) regardless of what was sent.
func (s *AgentService) ReportEvent(ctx context.Context, device *model.Device, sessionID, eventType string, metadata map[string]any) error {
	if !allowedAgentEventTypes[eventType] {
		return ErrInvalid
	}
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrNotFound
		}
		return err
	}
	if sess.DeviceID == nil || *sess.DeviceID != device.ID {
		return ErrForbidden
	}
	s.audit.RecordBestEffort(ctx, audit.Entry{
		EventType:    eventType,
		SessionID:    audit.Ptr(sess.ID),
		TechnicianID: sess.TechnicianID,
		DeviceID:     audit.Ptr(device.ID),
		Metadata:     sanitizeEventMetadata(eventType, metadata),
	})
	return nil
}

// sanitizeEventMetadata whitelists non-sensitive metadata per event type so an
// agent (or a compromised peer) cannot smuggle content into the audit trail.
func sanitizeEventMetadata(eventType string, m map[string]any) map[string]any {
	out := map[string]any{}
	if m == nil {
		return out
	}
	keep := func(keys ...string) {
		for _, k := range keys {
			if v, ok := m[k]; ok {
				out[k] = v
			}
		}
	}
	switch eventType {
	case audit.EventFileTransfer:
		keep("name", "size", "direction")
	case audit.EventClipboardSync:
		keep("direction", "length")
	case audit.EventInputCommandTry:
		keep("count", "kind")
	}
	return out
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

package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/signal"
	"github.com/remote-support/backend/internal/store"
)

// SessionService owns session lifecycle.
type SessionService struct {
	cfg   *config.Config
	store *store.Store
	cache *cache.Cache
	audit *audit.Service
	hub   *signal.Hub
	log   *slog.Logger
}

// ICEServers returns the ICE server list handed to peers.
func (s *SessionService) ICEServers() []model.ICEServer { return s.cfg.ICEServers }

// CreateUnattended starts a pending unattended session against an online device
// and pushes session-control:start to the agent. Writes session.request.
func (s *SessionService) CreateUnattended(ctx context.Context, techID, deviceID, ip string) (*model.Session, error) {
	if deviceID == "" {
		return nil, ErrInvalid
	}
	device, err := s.store.GetDevice(ctx, deviceID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	online, err := s.cache.IsOnline(ctx, device.ID)
	if err != nil {
		return nil, err
	}
	if !online {
		return nil, ErrConflict // device offline
	}
	open, err := s.store.HasOpenSession(ctx, device.ID)
	if err != nil {
		return nil, err
	}
	if open {
		return nil, ErrConflict // already in a session
	}

	now := time.Now().UTC()
	techPtr := techID
	deviceIDVal := device.ID
	sess := &model.Session{
		ID:            uuid.NewString(),
		DeviceID:      &deviceIDVal,
		TechnicianID:  &techPtr,
		Type:          model.SessionTypeUnattended,
		Status:        model.SessionStatusPending,
		BannerVisible: false,
		CreatedAt:     now,
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, err
	}

	// session.request is a lifecycle event: fail the action if audit fails.
	if err := s.audit.Record(ctx, audit.Entry{
		EventType:    audit.EventSessionRequest,
		SessionID:    audit.Ptr(sess.ID),
		TechnicianID: audit.Ptr(techID),
		DeviceID:     audit.Ptr(device.ID),
		Metadata:     map[string]any{"type": "unattended", "ip": ip},
	}); err != nil {
		return nil, err
	}

	// Bind and notify the agent so it displays the banner and begins capture.
	s.hub.BindSession(sess.ID, device.ID)
	if !s.hub.SendToAgent(device.ID, signal.ControlEnvelope(sess.ID, "start")) {
		s.log.Info("agent signaling socket not connected at session create", "device_id", device.ID, "session_id", sess.ID)
	}
	return sess, nil
}

// Get returns a session by id.
func (s *SessionService) Get(ctx context.Context, id string) (*model.Session, error) {
	sess, err := s.store.GetSession(ctx, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return sess, nil
}

// List returns sessions with optional filters, newest first.
func (s *SessionService) List(ctx context.Context, status, deviceID string, limit int) ([]model.Session, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	return s.store.ListSessions(ctx, status, deviceID, limit)
}

// ActivateFromBanner is called when an agent acks banner:visible. It flips the
// session to active (recording banner + start time) and writes session.start.
// The session is verified to belong to the acking agent's device.
func (s *SessionService) ActivateFromBanner(ctx context.Context, sessionID, deviceID string) error {
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrNotFound
		}
		return err
	}
	if sess.DeviceID == nil || *sess.DeviceID != deviceID {
		return ErrForbidden
	}
	if sess.Status != model.SessionStatusPending {
		// Idempotent: already active/ended, nothing to do.
		return nil
	}
	updated, err := s.store.MarkSessionActive(ctx, sessionID, time.Now().UTC())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil // raced to non-pending
		}
		return err
	}
	if err := s.audit.Record(ctx, audit.Entry{
		EventType:    audit.EventSessionStart,
		SessionID:    audit.Ptr(updated.ID),
		TechnicianID: updated.TechnicianID,
		DeviceID:     updated.DeviceID,
		Metadata:     map[string]any{"banner_visible": true},
	}); err != nil {
		return err
	}
	// Let the technician console know the banner is up and the session is active.
	s.hub.SendToTech(sessionID, signal.BannerEnvelope(sessionID))
	return nil
}

// End terminates a session, notifies both peers, and writes session.end.
func (s *SessionService) End(ctx context.Context, sessionID, techID, ip string) (*model.Session, error) {
	existing, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	updated, err := s.store.EndSession(ctx, existing.ID, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	if err := s.audit.Record(ctx, audit.Entry{
		EventType:    audit.EventSessionEnd,
		SessionID:    audit.Ptr(updated.ID),
		TechnicianID: audit.Ptr(techID),
		DeviceID:     updated.DeviceID,
		Metadata:     map[string]any{"ip": ip},
	}); err != nil {
		return nil, err
	}
	// Notify both peers, then release the hub binding.
	if updated.DeviceID != nil {
		s.hub.SendToAgent(*updated.DeviceID, signal.ControlEnvelope(updated.ID, "end"))
	}
	s.hub.SendToTech(updated.ID, signal.ControlEnvelope(updated.ID, "end"))
	s.hub.UnbindSession(updated.ID)
	return updated, nil
}

package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	// Persist the pending session and its session.request audit row atomically:
	// if the (synchronous, lifecycle) audit write fails, the pending session must
	// not remain committed — otherwise it would block every future session for
	// this device via HasOpenSession. The partial unique index ux_sessions_open_
	// device also turns a lost TOCTOU race into a 23505 we map to ErrConflict.
	if err := s.store.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.store.CreateSessionTx(ctx, tx, sess); err != nil {
			return err
		}
		return s.audit.RecordTx(ctx, tx, audit.Entry{
			EventType:    audit.EventSessionRequest,
			SessionID:    audit.Ptr(sess.ID),
			TechnicianID: audit.Ptr(techID),
			DeviceID:     audit.Ptr(device.ID),
			Metadata:     map[string]any{"type": "unattended", "ip": ip},
		})
	}); err != nil {
		if store.IsUniqueViolation(err) {
			return nil, ErrConflict // raced another open session for this device
		}
		return nil, err
	}

	// Bind and notify the agent so it displays the banner and begins capture.
	s.hub.BindSession(sess.ID, device.ID)
	if !s.hub.SendToAgent(device.ID, s.StartControlEnvelope(ctx, sess)) {
		s.log.Info("agent signaling socket not connected at session create", "device_id", device.ID, "session_id", sess.ID)
	}
	return sess, nil
}

// StartControlEnvelope builds the session-control:start envelope for a session,
// resolving the technician's display name (fallback email) into technician_name
// for the agent's consent banner. On lookup failure it falls back to an empty
// name so the start is still delivered.
func (s *SessionService) StartControlEnvelope(ctx context.Context, sess *model.Session) signal.Envelope {
	name := ""
	if sess.TechnicianID != nil {
		if tech, err := s.store.GetTechnicianByID(ctx, *sess.TechnicianID); err == nil {
			if name = tech.DisplayName; name == "" {
				name = tech.Email
			}
		} else {
			s.log.Warn("technician lookup for start banner failed", "technician_id", *sess.TechnicianID, "err", err)
		}
	}
	return signal.StartControlEnvelope(sess.ID, name)
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
	// Write session.start BEFORE flipping the session active. If the audit write
	// fails we return the error and the session stays pending, so remote control
	// can never proceed on an active-yet-unaudited session. The WS handler treats
	// this error as fatal and tears the session down.
	if err := s.audit.Record(ctx, audit.Entry{
		EventType:    audit.EventSessionStart,
		SessionID:    audit.Ptr(sess.ID),
		TechnicianID: sess.TechnicianID,
		DeviceID:     sess.DeviceID,
		Metadata:     map[string]any{"banner_visible": true},
	}); err != nil {
		return err
	}
	if _, err := s.store.MarkSessionActive(ctx, sessionID, time.Now().UTC()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil // raced to non-pending
		}
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
	// Idempotent: an already-ended session is returned as-is with no second
	// session.end audit, peer notification, or hub unbind.
	if existing.Status == model.SessionStatusEnded {
		return existing, nil
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

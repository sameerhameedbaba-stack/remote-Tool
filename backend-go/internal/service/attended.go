package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/auth"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/signal"
	"github.com/remote-support/backend/internal/store"
)

// AttendedService owns one-time attended session codes and code redemption.
type AttendedService struct {
	cfg   *config.Config
	store *store.Store
	cache *cache.Cache
	audit *audit.Service
	hub   *signal.Hub
	log   *slog.Logger
}

// CodeResult is returned to the technician on code creation.
type CodeResult struct {
	Code      string
	SessionID string
	ExpiresAt time.Time
}

// CreateCode creates a pending attended session and a one-time code mapped to it
// in Redis. Only sha256(code) is stored; the plaintext is returned once.
func (s *AttendedService) CreateCode(ctx context.Context, techID, label, ip string) (*CodeResult, error) {
	now := time.Now().UTC()
	techPtr := techID
	sess := &model.Session{
		ID:           uuid.NewString(),
		DeviceID:     nil, // bound at join
		TechnicianID: &techPtr,
		Type:         model.SessionTypeAttended,
		Status:       model.SessionStatusPending,
		CreatedAt:    now,
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, err
	}

	// session.request (attended) is a lifecycle event: fail the action on error.
	if err := s.audit.Record(ctx, audit.Entry{
		EventType:    audit.EventSessionRequest,
		SessionID:    audit.Ptr(sess.ID),
		TechnicianID: audit.Ptr(techID),
		Metadata:     map[string]any{"type": "attended", "label": label, "ip": ip},
	}); err != nil {
		return nil, err
	}

	code, err := auth.GenerateSessionCode(s.cfg.SessionCodeLength)
	if err != nil {
		return nil, err
	}
	if err := s.cache.StoreSessionCode(ctx, auth.HashSessionCode(s.cfg.JWTSecret, code), sess.ID, s.cfg.SessionCodeTTL); err != nil {
		return nil, err
	}

	return &CodeResult{
		Code:      code,
		SessionID: sess.ID,
		ExpiresAt: now.Add(s.cfg.SessionCodeTTL),
	}, nil
}

// JoinResult is returned to the portable agent on successful redemption.
type JoinResult struct {
	SessionID   string
	DeviceToken string
	ICEServers  []model.ICEServer
}

// Join redeems an attended code: validates + burns it atomically, creates an
// ephemeral attended device bound to the session, and returns an ephemeral
// device token. Writes session.approve (code entry = end-user consent).
func (s *AttendedService) Join(ctx context.Context, code, hostname, os, ip string) (*JoinResult, error) {
	normalized := auth.NormalizeSessionCode(code)
	if len(normalized) != s.cfg.SessionCodeLength {
		return nil, ErrInvalid
	}

	// Single-use: GETDEL burns the code atomically.
	sessionID, err := s.cache.RedeemSessionCode(ctx, auth.HashSessionCode(s.cfg.JWTSecret, code))
	if err != nil {
		if errors.Is(err, cache.ErrCodeNotFound) {
			// Absent means never-existed, expired, or already-used. We cannot
			// distinguish expiry from consumption with GETDEL alone, so we
			// report not_found. (See docs/API.md 410/404/409 note.)
			return nil, ErrNotFound
		}
		return nil, err
	}

	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound // code mapped to a session that has vanished
		}
		return nil, err
	}
	if sess.Status != model.SessionStatusPending || sess.DeviceID != nil {
		return nil, ErrConflict // already joined / not joinable
	}

	// Create the ephemeral attended device.
	secret, hash, err := auth.NewDeviceSecret()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	name := hostname
	if name == "" {
		name = "attended-" + sess.ID[:8]
	}
	device := &model.Device{
		ID:               uuid.NewString(),
		Name:             name,
		Hostname:         hostname,
		OS:               os,
		DeviceSecretHash: hash,
		Mode:             model.DeviceModeAttended,
		LastSeenAt:       &now,
		CreatedAt:        now,
	}
	// The code was already burned by the irreversible GETDEL above. Make the
	// device create + session bind + session.approve audit atomic so a partial
	// failure rolls back rather than leaving an orphan device or a half-bound
	// session (with the code already spent and unrecoverable).
	if err := s.store.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.store.CreateDeviceTx(ctx, tx, device); err != nil {
			return err
		}
		if err := s.store.BindSessionDeviceTx(ctx, tx, sess.ID, device.ID); err != nil {
			return err
		}
		// session.approve: end user consented by entering the code. Lifecycle event.
		return s.audit.RecordTx(ctx, tx, audit.Entry{
			EventType:    audit.EventSessionApprove,
			SessionID:    audit.Ptr(sess.ID),
			TechnicianID: sess.TechnicianID,
			DeviceID:     audit.Ptr(device.ID),
			Metadata:     map[string]any{"ip": ip, "hostname": hostname, "os": os},
		})
	}); err != nil {
		return nil, err
	}

	// Mark presence and bind the hub so signaling + banner start can flow.
	if err := s.cache.SetPresence(ctx, device.ID, "attended"); err != nil {
		s.log.Warn("set attended presence failed", "device_id", device.ID, "err", err)
	}
	s.hub.BindSession(sess.ID, device.ID)

	return &JoinResult{
		SessionID:   sess.ID,
		DeviceToken: auth.FormatDeviceToken(device.ID, secret),
		ICEServers:  s.cfg.ICEServers,
	}, nil
}

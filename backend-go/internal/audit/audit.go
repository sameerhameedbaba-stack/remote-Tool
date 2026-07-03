// Package audit is the cross-cutting append-only audit service. Lifecycle
// events (session.*) are written synchronously and fail the action on error;
// high-volume data events are retried then logged.
package audit

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

// Closed set of audit event types (see docs/API.md).
const (
	EventAuthLogin       = "auth.login"
	EventAuthLoginFailed = "auth.login_failed"
	EventDeviceRegister  = "device.register"
	EventSessionRequest  = "session.request"
	EventSessionApprove  = "session.approve"
	EventSessionStart    = "session.start"
	EventSessionEnd      = "session.end"
	EventFileTransfer    = "file.transfer"
	EventClipboardSync   = "clipboard.sync"
	EventInputCommandTry = "input.command_attempt"
)

// Entry describes an event to record. Nil id fields are omitted.
type Entry struct {
	EventType    string
	SessionID    *string
	TechnicianID *string
	DeviceID     *string
	Metadata     map[string]any
}

// Service writes audit events.
type Service struct {
	store *store.Store
	log   *slog.Logger
}

// New builds an audit service.
func New(st *store.Store, log *slog.Logger) *Service {
	return &Service{store: st, log: log}
}

func (s *Service) build(e Entry) *model.AuditEvent {
	meta := e.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	return &model.AuditEvent{
		ID:           uuid.NewString(),
		EventType:    e.EventType,
		SessionID:    e.SessionID,
		TechnicianID: e.TechnicianID,
		DeviceID:     e.DeviceID,
		Metadata:     meta,
		CreatedAt:    time.Now().UTC(),
	}
}

// Record writes an event synchronously. Use for lifecycle events where a failed
// audit write must fail the originating action.
func (s *Service) Record(ctx context.Context, e Entry) error {
	ev := s.build(e)
	if err := s.store.InsertAuditEvent(ctx, ev); err != nil {
		s.log.Error("audit write failed", "event_type", e.EventType, "err", err)
		return err
	}
	return nil
}

// RecordBestEffort writes a high-volume data event, retrying briefly then
// logging on persistent failure. It never blocks the caller's success path.
func (s *Service) RecordBestEffort(ctx context.Context, e Entry) {
	ev := s.build(e)
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := s.store.InsertAuditEvent(ctx, ev); err == nil {
			return
		} else {
			lastErr = err
		}
		time.Sleep(time.Duration(attempt+1) * 10 * time.Millisecond)
	}
	s.log.Error("audit write dropped after retries", "event_type", e.EventType, "err", lastErr)
}

// List returns audit events matching the filter (newest first). Read-only.
func (s *Service) List(ctx context.Context, f store.AuditFilter) ([]model.AuditEvent, error) {
	return s.store.ListAuditEvents(ctx, f)
}

// Ptr is a helper for building optional id fields.
func Ptr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

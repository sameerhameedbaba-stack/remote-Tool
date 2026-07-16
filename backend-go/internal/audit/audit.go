// Package audit is the cross-cutting append-only audit service. Lifecycle
// events (session.*) are written synchronously and fail the action on error;
// high-volume data events are retried then logged.
package audit

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

// Closed set of audit event types (see docs/API.md).
const (
	EventAuthLogin            = "auth.login"
	EventAuthLoginFailed      = "auth.login_failed"
	EventDeviceRegister       = "device.register"
	EventDeviceRegisterFailed = "device.register_failed"
	EventSessionRequest       = "session.request"
	EventSessionApprove       = "session.approve"
	EventSessionStart         = "session.start"
	EventSessionEnd           = "session.end"
	EventFileTransfer         = "file.transfer"
	EventClipboardSync        = "clipboard.sync"
	EventInputCommandTry      = "input.command_attempt"
	EventTechnicianCreated    = "technician.created"
	EventTechnicianUpdated    = "technician.updated"
)

// bestEffortQueueSize bounds the background queue for best-effort writes; past
// this depth new best-effort events are dropped (and logged) rather than
// blocking the request goroutine.
const bestEffortQueueSize = 1024

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

	queue     chan *model.AuditEvent
	wg        sync.WaitGroup
	closeOnce sync.Once
}

// New builds an audit service and starts its best-effort background worker.
func New(st *store.Store, log *slog.Logger) *Service {
	s := &Service{
		store: st,
		log:   log,
		queue: make(chan *model.AuditEvent, bestEffortQueueSize),
	}
	s.wg.Add(1)
	go s.worker()
	return s
}

// worker drains the best-effort queue, writing each event with a short detached
// timeout so a slow request context cannot stall or cancel the audit write.
func (s *Service) worker() {
	defer s.wg.Done()
	for ev := range s.queue {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		s.writeWithRetry(ctx, ev)
		cancel()
	}
}

// Close stops the background worker after draining queued events. Safe to call
// once during shutdown; subsequent calls are no-ops.
func (s *Service) Close() {
	s.closeOnce.Do(func() { close(s.queue) })
	s.wg.Wait()
}

func (s *Service) writeWithRetry(ctx context.Context, ev *model.AuditEvent) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := s.store.InsertAuditEvent(ctx, ev); err == nil {
			return
		} else {
			lastErr = err
		}
		time.Sleep(time.Duration(attempt+1) * 10 * time.Millisecond)
	}
	s.log.Error("audit write dropped after retries", "event_type", ev.EventType, "err", lastErr)
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

// RecordTx writes an event synchronously inside a caller-provided transaction,
// so a lifecycle event and its originating row commit or roll back together.
func (s *Service) RecordTx(ctx context.Context, tx pgx.Tx, e Entry) error {
	ev := s.build(e)
	if err := s.store.InsertAuditEventTx(ctx, tx, ev); err != nil {
		s.log.Error("audit write failed", "event_type", e.EventType, "err", err)
		return err
	}
	return nil
}

// RecordBestEffort hands a high-volume data event to a bounded background worker
// and returns immediately, so it never blocks (or is cancelled by) the request
// goroutine. On queue overflow the event is dropped and logged. The event is
// built now so its timestamp reflects when it occurred, not when it is written.
func (s *Service) RecordBestEffort(_ context.Context, e Entry) {
	ev := s.build(e)
	select {
	case s.queue <- ev:
	default:
		s.log.Error("audit best-effort queue full; dropping event", "event_type", e.EventType)
	}
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

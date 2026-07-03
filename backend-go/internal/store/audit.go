package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/remote-support/backend/internal/model"
)

// AuditFilter narrows an audit query. Empty fields are ignored.
type AuditFilter struct {
	SessionID    string
	DeviceID     string
	TechnicianID string
	EventType    string
	Since        *time.Time
	Until        *time.Time
	Limit        int

	// Keyset cursor: return rows strictly older than (CursorCreatedAt, CursorID).
	CursorCreatedAt *time.Time
	CursorID        string
}

// InsertAuditEvent appends one audit row. The audit table is append-only.
func (s *Store) InsertAuditEvent(ctx context.Context, e *model.AuditEvent) error {
	return insertAuditEvent(ctx, s.pool, e)
}

// InsertAuditEventTx appends one audit row inside a transaction.
func (s *Store) InsertAuditEventTx(ctx context.Context, q Querier, e *model.AuditEvent) error {
	return insertAuditEvent(ctx, q, e)
}

func insertAuditEvent(ctx context.Context, q Querier, e *model.AuditEvent) error {
	meta := e.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	// Pass the JSON as a string so Postgres casts text->jsonb; a []byte would be
	// encoded as bytea and rejected by the jsonb column.
	_, err = q.Exec(ctx,
		`INSERT INTO audit_events (id, event_type, session_id, technician_id, device_id, metadata, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		e.ID, e.EventType, e.SessionID, e.TechnicianID, e.DeviceID, string(raw), e.CreatedAt)
	return err
}

// ListAuditEvents returns audit rows newest-first honoring the filter and
// keyset cursor. The WHERE clause is built dynamically so that only predicates
// that are actually set are emitted; a set session_id/device_id/technician_id
// then produces a plain `col = $n::uuid` term the partial indexes can use,
// instead of the `($n = ” OR col = $n)` form that defeats them.
func (s *Store) ListAuditEvents(ctx context.Context, f AuditFilter) ([]model.AuditEvent, error) {
	var conds []string
	var args []any
	add := func(format string, val any) {
		args = append(args, val)
		conds = append(conds, fmt.Sprintf(format, len(args)))
	}
	if f.SessionID != "" {
		add("session_id = $%d::uuid", f.SessionID)
	}
	if f.DeviceID != "" {
		add("device_id = $%d::uuid", f.DeviceID)
	}
	if f.TechnicianID != "" {
		add("technician_id = $%d::uuid", f.TechnicianID)
	}
	if f.EventType != "" {
		add("event_type = $%d", f.EventType)
	}
	if f.Since != nil {
		add("created_at >= $%d", *f.Since)
	}
	if f.Until != nil {
		add("created_at <= $%d", *f.Until)
	}
	if f.CursorCreatedAt != nil && f.CursorID != "" {
		args = append(args, *f.CursorCreatedAt, f.CursorID)
		conds = append(conds, fmt.Sprintf("(created_at, id) < ($%d, $%d::uuid)", len(args)-1, len(args)))
	}

	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	args = append(args, f.Limit)
	query := fmt.Sprintf(
		`SELECT id, event_type, session_id, technician_id, device_id, metadata, created_at
		 FROM audit_events
		 %s
		 ORDER BY created_at DESC, id DESC
		 LIMIT $%d`, where, len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.AuditEvent
	for rows.Next() {
		var e model.AuditEvent
		var raw []byte
		if err := rows.Scan(&e.ID, &e.EventType, &e.SessionID, &e.TechnicianID,
			&e.DeviceID, &raw, &e.CreatedAt); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &e.Metadata)
		}
		if e.Metadata == nil {
			e.Metadata = map[string]any{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

package store

import (
	"context"
	"encoding/json"
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
	_, err = s.pool.Exec(ctx,
		`INSERT INTO audit_events (id, event_type, session_id, technician_id, device_id, metadata, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		e.ID, e.EventType, e.SessionID, e.TechnicianID, e.DeviceID, string(raw), e.CreatedAt)
	return err
}

// ListAuditEvents returns audit rows newest-first honoring the filter and
// keyset cursor.
func (s *Store) ListAuditEvents(ctx context.Context, f AuditFilter) ([]model.AuditEvent, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, event_type, session_id, technician_id, device_id, metadata, created_at
		 FROM audit_events
		 WHERE ($1 = '' OR session_id = $1::uuid)
		   AND ($2 = '' OR device_id = $2::uuid)
		   AND ($3 = '' OR technician_id = $3::uuid)
		   AND ($4 = '' OR event_type = $4)
		   AND ($5::timestamptz IS NULL OR created_at >= $5)
		   AND ($6::timestamptz IS NULL OR created_at <= $6)
		   AND ($7::timestamptz IS NULL OR (created_at, id) < ($7, $8::uuid))
		 ORDER BY created_at DESC, id DESC
		 LIMIT $9`,
		f.SessionID, f.DeviceID, f.TechnicianID, f.EventType,
		f.Since, f.Until, f.CursorCreatedAt, nullableUUID(f.CursorID), f.Limit)
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

// nullableUUID returns nil for an empty string so the ::uuid cast in the keyset
// predicate is not applied when there is no cursor.
func nullableUUID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

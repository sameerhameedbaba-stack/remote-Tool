package store

import (
	"context"
	"time"

	"github.com/remote-support/backend/internal/model"
)

// CreateSession inserts a new session row.
func (s *Store) CreateSession(ctx context.Context, sess *model.Session) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sessions (id, device_id, technician_id, type, status, banner_visible, started_at, ended_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		sess.ID, sess.DeviceID, sess.TechnicianID, sess.Type, sess.Status,
		sess.BannerVisible, sess.StartedAt, sess.EndedAt, sess.CreatedAt)
	return err
}

// GetSession looks up a session by id.
func (s *Store) GetSession(ctx context.Context, id string) (*model.Session, error) {
	var sess model.Session
	err := s.pool.QueryRow(ctx,
		`SELECT id, device_id, technician_id, type, status, banner_visible, started_at, ended_at, created_at
		 FROM sessions WHERE id = $1`, id).Scan(
		&sess.ID, &sess.DeviceID, &sess.TechnicianID, &sess.Type, &sess.Status,
		&sess.BannerVisible, &sess.StartedAt, &sess.EndedAt, &sess.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &sess, nil
}

// ListSessions returns sessions (most recent first) with optional filters.
func (s *Store) ListSessions(ctx context.Context, status, deviceID string, limit int) ([]model.Session, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, device_id, technician_id, type, status, banner_visible, started_at, ended_at, created_at
		 FROM sessions
		 WHERE ($1 = '' OR status = $1)
		   AND ($2 = '' OR device_id = $2::uuid)
		 ORDER BY created_at DESC
		 LIMIT $3`, status, deviceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.Session
	for rows.Next() {
		var sess model.Session
		if err := rows.Scan(&sess.ID, &sess.DeviceID, &sess.TechnicianID, &sess.Type, &sess.Status,
			&sess.BannerVisible, &sess.StartedAt, &sess.EndedAt, &sess.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

// BindSessionDevice sets the device_id on a session (attended join binding).
func (s *Store) BindSessionDevice(ctx context.Context, sessionID, deviceID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sessions SET device_id = $2 WHERE id = $1 AND device_id IS NULL`,
		sessionID, deviceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetOpenSessionForDevice returns the device's pending or active session, if any.
func (s *Store) GetOpenSessionForDevice(ctx context.Context, deviceID string) (*model.Session, error) {
	var sess model.Session
	err := s.pool.QueryRow(ctx,
		`SELECT id, device_id, technician_id, type, status, banner_visible, started_at, ended_at, created_at
		 FROM sessions
		 WHERE device_id = $1 AND status IN ('pending','active')
		 ORDER BY created_at DESC
		 LIMIT 1`, deviceID).Scan(
		&sess.ID, &sess.DeviceID, &sess.TechnicianID, &sess.Type, &sess.Status,
		&sess.BannerVisible, &sess.StartedAt, &sess.EndedAt, &sess.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &sess, nil
}

// HasOpenSession reports whether the device already has a pending or active
// session (used to reject a duplicate start with 409 conflict).
func (s *Store) HasOpenSession(ctx context.Context, deviceID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM sessions
			WHERE device_id = $1 AND status IN ('pending','active'))`, deviceID).Scan(&exists)
	return exists, err
}

// MarkSessionActive flips a session to active and records banner visibility and
// start time. It only affects sessions still pending.
func (s *Store) MarkSessionActive(ctx context.Context, id string, started time.Time) (*model.Session, error) {
	var sess model.Session
	err := s.pool.QueryRow(ctx,
		`UPDATE sessions
		 SET status = 'active', banner_visible = true, started_at = $2
		 WHERE id = $1 AND status = 'pending'
		 RETURNING id, device_id, technician_id, type, status, banner_visible, started_at, ended_at, created_at`,
		id, started).Scan(
		&sess.ID, &sess.DeviceID, &sess.TechnicianID, &sess.Type, &sess.Status,
		&sess.BannerVisible, &sess.StartedAt, &sess.EndedAt, &sess.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &sess, nil
}

// EndSession marks a session ended (if not already) and returns the row.
func (s *Store) EndSession(ctx context.Context, id string, ended time.Time) (*model.Session, error) {
	var sess model.Session
	err := s.pool.QueryRow(ctx,
		`UPDATE sessions
		 SET status = 'ended', ended_at = COALESCE(ended_at, $2)
		 WHERE id = $1
		 RETURNING id, device_id, technician_id, type, status, banner_visible, started_at, ended_at, created_at`,
		id, ended).Scan(
		&sess.ID, &sess.DeviceID, &sess.TechnicianID, &sess.Type, &sess.Status,
		&sess.BannerVisible, &sess.StartedAt, &sess.EndedAt, &sess.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &sess, nil
}

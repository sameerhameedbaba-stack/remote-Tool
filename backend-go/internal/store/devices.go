package store

import (
	"context"
	"time"

	"github.com/remote-support/backend/internal/model"
)

// CreateDevice inserts a device (unattended enrollment or ephemeral attended).
func (s *Store) CreateDevice(ctx context.Context, d *model.Device) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO devices (id, name, hostname, os, device_secret_hash, mode, app_version, last_seen_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		d.ID, d.Name, d.Hostname, d.OS, d.DeviceSecretHash, d.Mode, d.AppVersion, d.LastSeenAt, d.CreatedAt)
	return err
}

// GetDevice looks up a device by id.
func (s *Store) GetDevice(ctx context.Context, id string) (*model.Device, error) {
	var d model.Device
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, hostname, os, device_secret_hash, mode, app_version, last_seen_at, created_at
		 FROM devices WHERE id = $1`, id).Scan(
		&d.ID, &d.Name, &d.Hostname, &d.OS, &d.DeviceSecretHash, &d.Mode, &d.AppVersion, &d.LastSeenAt, &d.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &d, nil
}

// ListDevices returns unattended devices, optionally filtered by a name/hostname
// substring. Presence status is applied by the caller from Redis.
func (s *Store) ListDevices(ctx context.Context, nameQuery string) ([]model.Device, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, hostname, os, device_secret_hash, mode, app_version, last_seen_at, created_at
		 FROM devices
		 WHERE mode = 'unattended'
		   AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR hostname ILIKE '%' || $1 || '%')
		 ORDER BY created_at DESC`, nameQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.Device
	for rows.Next() {
		var d model.Device
		if err := rows.Scan(&d.ID, &d.Name, &d.Hostname, &d.OS, &d.DeviceSecretHash,
			&d.Mode, &d.AppVersion, &d.LastSeenAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// UpdateLastSeen sets last_seen_at (called on heartbeat).
func (s *Store) UpdateLastSeen(ctx context.Context, deviceID string, seen time.Time, appVersion string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE devices SET last_seen_at = $2,
		        app_version = CASE WHEN $3 = '' THEN app_version ELSE $3 END
		 WHERE id = $1`, deviceID, seen, appVersion)
	return err
}

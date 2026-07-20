package store

import "context"

// DeviceOverride is the platform's per-device display customization, keyed by
// the RustDesk device id.
type DeviceOverride struct {
	Alias  string
	Hidden bool
}

// ListDeviceOverrides returns every override keyed by RustDesk id.
func (s *Store) ListDeviceOverrides(ctx context.Context) (map[string]DeviceOverride, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT rustdesk_id, COALESCE(alias, ''), hidden FROM device_overrides`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]DeviceOverride)
	for rows.Next() {
		var id, alias string
		var hidden bool
		if err := rows.Scan(&id, &alias, &hidden); err != nil {
			return nil, err
		}
		out[id] = DeviceOverride{Alias: alias, Hidden: hidden}
	}
	return out, rows.Err()
}

// SetDeviceAlias upserts a display alias for a device. An empty alias clears it.
func (s *Store) SetDeviceAlias(ctx context.Context, rustdeskID, alias string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO device_overrides (rustdesk_id, alias, updated_at)
		 VALUES ($1, NULLIF($2, ''), now())
		 ON CONFLICT (rustdesk_id)
		 DO UPDATE SET alias = NULLIF($2, ''), updated_at = now()`,
		rustdeskID, alias)
	return err
}

// SetDeviceHidden upserts the hidden flag for a device (used by delete).
func (s *Store) SetDeviceHidden(ctx context.Context, rustdeskID string, hidden bool) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO device_overrides (rustdesk_id, hidden, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (rustdesk_id)
		 DO UPDATE SET hidden = $2, updated_at = now()`,
		rustdeskID, hidden)
	return err
}

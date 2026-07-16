package store

import (
	"context"

	"github.com/remote-support/backend/internal/model"
)

// technicianCols is the shared SELECT column list for scanTechnician.
const technicianCols = `id, email, username, password_hash, display_name, role, active, created_by, created_at`

// CountTechnicians returns the number of technician rows.
func (s *Store) CountTechnicians(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM technicians`).Scan(&n)
	return n, err
}

// CreateTechnician inserts a technician (tenant).
func (s *Store) CreateTechnician(ctx context.Context, t *model.Technician) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO technicians (id, email, username, password_hash, display_name, role, active, created_by, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		t.ID, t.Email, t.Username, t.PasswordHash, t.DisplayName, t.Role, t.Active, t.CreatedBy, t.CreatedAt)
	return mapErr(err)
}

// GetTechnicianByEmail looks up a technician by email (case-sensitive).
func (s *Store) GetTechnicianByEmail(ctx context.Context, email string) (*model.Technician, error) {
	return s.scanTechnician(ctx,
		`SELECT `+technicianCols+` FROM technicians WHERE email = $1`, email)
}

// GetTechnicianByUsername looks up a technician by their tenant username.
func (s *Store) GetTechnicianByUsername(ctx context.Context, username string) (*model.Technician, error) {
	return s.scanTechnician(ctx,
		`SELECT `+technicianCols+` FROM technicians WHERE username = $1`, username)
}

// GetTechnicianByID looks up a technician by id.
func (s *Store) GetTechnicianByID(ctx context.Context, id string) (*model.Technician, error) {
	return s.scanTechnician(ctx,
		`SELECT `+technicianCols+` FROM technicians WHERE id = $1`, id)
}

// ListTechnicians returns technicians created by `createdBy` (a super-admin),
// newest first. Pass an empty string to list all technicians (platform-wide).
// PasswordHash is cleared on every returned row.
func (s *Store) ListTechnicians(ctx context.Context, createdBy string, limit int) ([]model.Technician, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := `SELECT ` + technicianCols + ` FROM technicians`
	var args []any
	if createdBy != "" {
		query += ` WHERE created_by = $1 ORDER BY created_at DESC LIMIT $2`
		args = []any{createdBy, limit}
	} else {
		query += ` ORDER BY created_at DESC LIMIT $1`
		args = []any{limit}
	}
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()

	var out []model.Technician
	for rows.Next() {
		var t model.Technician
		if err := rows.Scan(&t.ID, &t.Email, &t.Username, &t.PasswordHash,
			&t.DisplayName, &t.Role, &t.Active, &t.CreatedBy, &t.CreatedAt); err != nil {
			return nil, mapErr(err)
		}
		t.PasswordHash = ""
		out = append(out, t)
	}
	return out, mapErr(rows.Err())
}

// SetTechnicianActive enables/disables a technician (does not delete).
func (s *Store) SetTechnicianActive(ctx context.Context, id string, active bool) error {
	tag, err := s.pool.Exec(ctx, `UPDATE technicians SET active = $2 WHERE id = $1`, id, active)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) scanTechnician(ctx context.Context, query string, args ...any) (*model.Technician, error) {
	var t model.Technician
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&t.ID, &t.Email, &t.Username, &t.PasswordHash,
		&t.DisplayName, &t.Role, &t.Active, &t.CreatedBy, &t.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &t, nil
}

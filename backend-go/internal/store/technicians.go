package store

import (
	"context"

	"github.com/remote-support/backend/internal/model"
)

// CountTechnicians returns the number of technician rows.
func (s *Store) CountTechnicians(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM technicians`).Scan(&n)
	return n, err
}

// CreateTechnician inserts a technician.
func (s *Store) CreateTechnician(ctx context.Context, t *model.Technician) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO technicians (id, email, password_hash, display_name, role, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		t.ID, t.Email, t.PasswordHash, t.DisplayName, t.Role, t.CreatedAt)
	return err
}

// GetTechnicianByEmail looks up a technician by email (case-sensitive).
func (s *Store) GetTechnicianByEmail(ctx context.Context, email string) (*model.Technician, error) {
	return s.scanTechnician(ctx,
		`SELECT id, email, password_hash, display_name, role, created_at
		 FROM technicians WHERE email = $1`, email)
}

// GetTechnicianByID looks up a technician by id.
func (s *Store) GetTechnicianByID(ctx context.Context, id string) (*model.Technician, error) {
	return s.scanTechnician(ctx,
		`SELECT id, email, password_hash, display_name, role, created_at
		 FROM technicians WHERE id = $1`, id)
}

func (s *Store) scanTechnician(ctx context.Context, query string, args ...any) (*model.Technician, error) {
	var t model.Technician
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&t.ID, &t.Email, &t.PasswordHash, &t.DisplayName, &t.Role, &t.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &t, nil
}

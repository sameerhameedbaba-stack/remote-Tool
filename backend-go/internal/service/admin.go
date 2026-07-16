package service

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/auth"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

// AdminService is the platform super-admin surface: provisioning and managing
// technician tenants. Every method is called only after the transport layer has
// verified an `admin`-role principal.
type AdminService struct {
	store *store.Store
	audit *audit.Service
	log   *slog.Logger
}

// usernameRe enforces a DNS-label-safe tenant username (used as a subdomain):
// 3–30 chars, lowercase alphanumerics and hyphens, no leading/trailing hyphen.
var usernameRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$`)

// reservedUsernames may not be claimed as tenant subdomains — they collide with
// platform hostnames or common infra names.
var reservedUsernames = map[string]bool{
	"admin": true, "www": true, "api": true, "connect": true, "app": true,
	"mail": true, "ftp": true, "ns1": true, "ns2": true, "root": true,
	"support": true, "help": true, "status": true, "static": true,
	"assets": true, "cdn": true, "portal": true, "dashboard": true,
}

func normalizeUsername(u string) string { return strings.ToLower(strings.TrimSpace(u)) }

func validateUsername(u string) error {
	if !usernameRe.MatchString(u) {
		return ErrInvalid
	}
	if reservedUsernames[u] {
		return ErrConflict
	}
	return nil
}

// TechnicianInput is the payload for creating a tenant technician.
type TechnicianInput struct {
	Email       string
	Username    string
	DisplayName string
	Password    string
}

// CreateTechnician provisions a new technician tenant owned by `adminID`.
func (s *AdminService) CreateTechnician(ctx context.Context, adminID string, in TechnicianInput) (*model.Technician, error) {
	email := strings.ToLower(strings.TrimSpace(in.Email))
	username := normalizeUsername(in.Username)
	if email == "" || !strings.Contains(email, "@") {
		return nil, ErrInvalid
	}
	if len(in.Password) < 8 {
		return nil, ErrInvalid
	}
	if err := validateUsername(username); err != nil {
		return nil, err
	}

	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return nil, err
	}
	owner := adminID
	tech := &model.Technician{
		ID:           uuid.NewString(),
		Email:        email,
		Username:     username,
		PasswordHash: hash,
		DisplayName:  strings.TrimSpace(in.DisplayName),
		Role:         model.RoleTechnician,
		Active:       true,
		CreatedBy:    &owner,
		CreatedAt:    time.Now().UTC(),
	}
	if err := s.store.CreateTechnician(ctx, tech); err != nil {
		if store.IsUniqueViolation(err) {
			return nil, ErrConflict // duplicate email or username
		}
		return nil, err
	}

	s.audit.RecordBestEffort(ctx, audit.Entry{
		EventType:    audit.EventTechnicianCreated,
		TechnicianID: audit.Ptr(adminID),
		Metadata:     map[string]any{"technician_id": tech.ID, "username": username, "email": email},
	})
	tech.PasswordHash = ""
	return tech, nil
}

// ListTechnicians returns the technicians owned by `adminID`.
func (s *AdminService) ListTechnicians(ctx context.Context, adminID string, limit int) ([]model.Technician, error) {
	return s.store.ListTechnicians(ctx, adminID, limit)
}

// SetTechnicianActive enables/disables a technician the admin owns.
func (s *AdminService) SetTechnicianActive(ctx context.Context, adminID, techID string, active bool) error {
	t, err := s.store.GetTechnicianByID(ctx, techID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrNotFound
		}
		return err
	}
	// Tenant isolation: an admin may only manage technicians they created.
	if t.CreatedBy == nil || *t.CreatedBy != adminID {
		return ErrForbidden
	}
	if err := s.store.SetTechnicianActive(ctx, techID, active); err != nil {
		return err
	}
	s.audit.RecordBestEffort(ctx, audit.Entry{
		EventType:    audit.EventTechnicianUpdated,
		TechnicianID: audit.Ptr(adminID),
		Metadata:     map[string]any{"technician_id": techID, "active": active},
	})
	return nil
}

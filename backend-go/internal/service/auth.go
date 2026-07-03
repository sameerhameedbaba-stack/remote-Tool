package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/auth"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

// AuthService handles technician login and device-token verification.
type AuthService struct {
	cfg   *config.Config
	store *store.Store
	audit *audit.Service
	log   *slog.Logger
}

// LoginResult is returned to the handler on success.
type LoginResult struct {
	Token      string
	ExpiresAt  time.Time
	Technician *model.Technician
}

// Login verifies credentials and issues a JWT. Writes auth.login on success and
// auth.login_failed on failure. Returns ErrUnauthorized on bad credentials.
func (s *AuthService) Login(ctx context.Context, email, password, ip string) (*LoginResult, error) {
	if email == "" || password == "" {
		return nil, ErrInvalid
	}
	tech, err := s.store.GetTechnicianByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Perform equivalent argon2id work so an unknown email is not
			// distinguishable from a wrong password by timing (user enumeration).
			auth.DummyPasswordVerify(password)
			s.audit.RecordBestEffort(ctx, audit.Entry{
				EventType: audit.EventAuthLoginFailed,
				Metadata:  map[string]any{"email": email, "ip": ip, "reason": "unknown_email"},
			})
			return nil, ErrUnauthorized
		}
		return nil, err
	}

	ok, err := auth.VerifyPassword(password, tech.PasswordHash)
	if err != nil || !ok {
		s.audit.RecordBestEffort(ctx, audit.Entry{
			EventType:    audit.EventAuthLoginFailed,
			TechnicianID: audit.Ptr(tech.ID),
			Metadata:     map[string]any{"email": email, "ip": ip, "reason": "bad_password"},
		})
		return nil, ErrUnauthorized
	}

	token, expires, err := auth.IssueJWT(s.cfg.JWTSecret, tech.ID, tech.Email, tech.Role, s.cfg.JWTTTL)
	if err != nil {
		return nil, err
	}

	// auth.login is a lifecycle-adjacent event; record synchronously.
	if err := s.audit.Record(ctx, audit.Entry{
		EventType:    audit.EventAuthLogin,
		TechnicianID: audit.Ptr(tech.ID),
		Metadata:     map[string]any{"email": tech.Email, "ip": ip},
	}); err != nil {
		return nil, err
	}

	return &LoginResult{Token: token, ExpiresAt: expires, Technician: tech}, nil
}

// GetTechnician returns a technician by id (for /me).
func (s *AuthService) GetTechnician(ctx context.Context, id string) (*model.Technician, error) {
	tech, err := s.store.GetTechnicianByID(ctx, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return tech, nil
}

// VerifyDeviceToken parses "<device_id>.<device_secret>" and verifies the
// secret against the stored argon2id hash in constant time. Used by middleware.
func (s *AuthService) VerifyDeviceToken(ctx context.Context, token string) (*model.Device, error) {
	deviceID, secret, err := auth.ParseDeviceToken(token)
	if err != nil {
		return nil, ErrUnauthorized
	}
	device, err := s.store.GetDevice(ctx, deviceID)
	if err != nil {
		return nil, ErrUnauthorized
	}
	ok, err := auth.VerifyPassword(secret, device.DeviceSecretHash)
	if err != nil || !ok {
		return nil, ErrUnauthorized
	}
	return device, nil
}

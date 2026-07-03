package config

import "testing"

func baseEnv(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db?sslmode=disable")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789012345678901234567890123456789")
	t.Setenv("AGENT_ENROLLMENT_TOKEN", "an-enrollment-token")
	t.Setenv("TURN_USER", "turnuser")
	t.Setenv("TURN_PASSWORD", "turnpass")
	t.Setenv("ICE_SERVERS", `["stun:coturn:3478","turn:coturn:3478"]`)
	t.Setenv("APP_ENV", "")
	t.Setenv("SEED_TECH_EMAIL", "")
	t.Setenv("SEED_TECH_PASSWORD", "")
	t.Setenv("SESSION_CODE_LENGTH", "9")
}

func TestLoadValid(t *testing.T) {
	baseEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SessionCodeLength != 9 {
		t.Fatalf("session code length: got %d", cfg.SessionCodeLength)
	}
	if len(cfg.ICEServers) != 2 {
		t.Fatalf("expected 2 ICE servers, got %d", len(cfg.ICEServers))
	}
	// STUN carries no credentials; TURN carries the long-term creds.
	if cfg.ICEServers[0].Username != "" {
		t.Fatalf("stun should have no username")
	}
	if cfg.ICEServers[1].Username != "turnuser" || cfg.ICEServers[1].Credential != "turnpass" {
		t.Fatalf("turn creds not applied: %+v", cfg.ICEServers[1])
	}
}

func TestLoadRejectsShortJWTSecret(t *testing.T) {
	baseEnv(t)
	t.Setenv("JWT_SECRET", "too-short")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for short JWT secret")
	}
}

func TestLoadRejectsPlaceholderInNonDev(t *testing.T) {
	baseEnv(t)
	t.Setenv("AGENT_ENROLLMENT_TOKEN", "change-me-enrollment-token")
	if _, err := Load(); err == nil {
		t.Fatal("expected placeholder rejection outside dev profile")
	}
}

func TestLoadAllowsPlaceholderInDev(t *testing.T) {
	baseEnv(t)
	t.Setenv("APP_ENV", "dev")
	t.Setenv("AGENT_ENROLLMENT_TOKEN", "change-me-enrollment-token")
	if _, err := Load(); err != nil {
		t.Fatalf("dev profile should allow placeholders: %v", err)
	}
}

func TestLoadRejectsBadSessionCodeLength(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_CODE_LENGTH", "99")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for out-of-range session code length")
	}
}

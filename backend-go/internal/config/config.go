// Package config loads and validates backend configuration from environment
// variables. The variable names match .env.example exactly. The backend
// refuses to start with weak or placeholder secrets outside a dev profile.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/remote-support/backend/internal/model"
)

// placeholderMarker is the substring .env.example uses for values that must be
// replaced before running in any non-dev environment.
const placeholderMarker = "change-me"

// Config is the fully-resolved runtime configuration.
type Config struct {
	AppEnv string // "dev" relaxes secret validation; anything else is strict.

	HTTPAddr    string
	DatabaseURL string
	RedisURL    string

	JWTSecret []byte
	JWTTTL    time.Duration

	AgentEnrollmentToken string

	SessionCodeTTL    time.Duration
	SessionCodeLength int

	CORSAllowedOrigin string
	// PlatformDomain is the apex domain (e.g. "tiefixy.com"). Tenant subdomains
	// are <username>.PlatformDomain. Used to gate on-demand TLS issuance.
	PlatformDomain string

	SeedTechEmail    string
	SeedTechPassword string

	// RustDesk Server Pro integration. The engine that powers screen/mouse/
	// keyboard is RustDesk; this platform wraps it (branding, 9-digit codes,
	// per-tenant fleet view). All values come from the environment — the API
	// token and server key are secrets and must never be committed.
	RustDeskAPIURL   string // e.g. http://200.97.171.196:21114
	RustDeskAPIToken string // Pro console API token (Bearer)
	RustDeskServerID string // ID/relay server host the clients point at
	RustDeskPubKey   string // server public key baked into branded clients

	// ConnectClientDir holds the branded client installers served to hosts. A
	// per-technician installer is <username>.exe; remote-agent.exe is the
	// generic fallback. Same directory Caddy mounts for /dl.
	ConnectClientDir string

	TURNRealm    string
	TURNUser     string
	TURNPassword string
	ICEServers   []model.ICEServer
}

// IsDev reports whether the strict secret checks are relaxed.
func (c *Config) IsDev() bool { return c.AppEnv == "dev" }

// Load reads configuration from the process environment and validates it.
func Load() (*Config, error) {
	c := &Config{
		AppEnv:               getenv("APP_ENV", ""),
		HTTPAddr:             getenv("BACKEND_HTTP_ADDR", ":8080"),
		DatabaseURL:          os.Getenv("DATABASE_URL"),
		RedisURL:             os.Getenv("REDIS_URL"),
		AgentEnrollmentToken: os.Getenv("AGENT_ENROLLMENT_TOKEN"),
		CORSAllowedOrigin:    getenv("CORS_ALLOWED_ORIGIN", "http://localhost:3000"),
		PlatformDomain:       os.Getenv("PLATFORM_DOMAIN"),
		SeedTechEmail:        os.Getenv("SEED_TECH_EMAIL"),
		SeedTechPassword:     os.Getenv("SEED_TECH_PASSWORD"),
		RustDeskAPIURL:       strings.TrimRight(os.Getenv("RUSTDESK_API_URL"), "/"),
		RustDeskAPIToken:     os.Getenv("RUSTDESK_API_TOKEN"),
		RustDeskServerID:     os.Getenv("RUSTDESK_SERVER_ID"),
		RustDeskPubKey:       os.Getenv("RUSTDESK_PUBLIC_KEY"),
		ConnectClientDir:     getenv("CONNECT_CLIENT_DIR", "/srv/agent"),
		TURNRealm:            os.Getenv("TURN_REALM"),
		TURNUser:             os.Getenv("TURN_USER"),
		TURNPassword:         os.Getenv("TURN_PASSWORD"),
	}

	c.JWTSecret = []byte(os.Getenv("JWT_SECRET"))

	var err error
	if c.JWTTTL, err = parseDuration(getenv("JWT_TTL", "3600s"), time.Hour); err != nil {
		return nil, fmt.Errorf("JWT_TTL: %w", err)
	}
	if c.SessionCodeTTL, err = parseDuration(getenv("SESSION_CODE_TTL", "300s"), 5*time.Minute); err != nil {
		return nil, fmt.Errorf("SESSION_CODE_TTL: %w", err)
	}

	c.SessionCodeLength, err = strconv.Atoi(getenv("SESSION_CODE_LENGTH", "9"))
	if err != nil || c.SessionCodeLength < 6 || c.SessionCodeLength > 12 {
		return nil, fmt.Errorf("SESSION_CODE_LENGTH must be an integer in [6,12], got %q", os.Getenv("SESSION_CODE_LENGTH"))
	}

	if c.ICEServers, err = parseICEServers(os.Getenv("ICE_SERVERS"), c.TURNUser, c.TURNPassword); err != nil {
		return nil, fmt.Errorf("ICE_SERVERS: %w", err)
	}

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Config) validate() error {
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if c.RedisURL == "" {
		return errors.New("REDIS_URL is required")
	}
	if len(c.JWTSecret) < 32 {
		return fmt.Errorf("JWT_SECRET must be at least 32 bytes, got %d", len(c.JWTSecret))
	}
	if c.AgentEnrollmentToken == "" {
		return errors.New("AGENT_ENROLLMENT_TOKEN is required")
	}

	// Reject placeholder secrets unless explicitly running the dev profile.
	if !c.IsDev() {
		secrets := map[string]string{
			"JWT_SECRET":             string(c.JWTSecret),
			"AGENT_ENROLLMENT_TOKEN": c.AgentEnrollmentToken,
			"DATABASE_URL":           c.DatabaseURL,
			"TURN_PASSWORD":          c.TURNPassword,
			"SEED_TECH_PASSWORD":     c.SeedTechPassword,
		}
		for name, val := range secrets {
			if strings.Contains(val, placeholderMarker) {
				return fmt.Errorf("%s still contains a placeholder value (%q); set a real secret or run with APP_ENV=dev", name, placeholderMarker)
			}
		}
	}
	return nil
}

// SeedEnabled reports whether a seed technician should be created on first boot.
func (c *Config) SeedEnabled() bool {
	return c.SeedTechEmail != "" && c.SeedTechPassword != ""
}

// RustDeskEnabled reports whether the RustDesk Pro integration is configured.
// When false, fleet endpoints degrade gracefully (empty list) instead of erroring
// so the platform still boots without the token wired in.
func (c *Config) RustDeskEnabled() bool {
	return c.RustDeskAPIURL != "" && c.RustDeskAPIToken != ""
}

func parseICEServers(raw, turnUser, turnPassword string) ([]model.ICEServer, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var urls []string
	if err := json.Unmarshal([]byte(raw), &urls); err != nil {
		return nil, fmt.Errorf("must be a JSON array of URL strings: %w", err)
	}
	servers := make([]model.ICEServer, 0, len(urls))
	for _, u := range urls {
		s := model.ICEServer{URLs: u}
		// TURN entries need long-term credentials; STUN entries do not.
		if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
			s.Username = turnUser
			s.Credential = turnPassword
		}
		servers = append(servers, s)
	}
	return servers, nil
}

func parseDuration(raw string, def time.Duration) (time.Duration, error) {
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, err
	}
	if d <= 0 {
		return 0, fmt.Errorf("must be positive, got %s", raw)
	}
	return d, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

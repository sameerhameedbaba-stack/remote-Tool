package service

import (
	"errors"
	"testing"
)

func TestValidateUsername(t *testing.T) {
	valid := []string{"jane", "acme-support", "tech01", "a1b", "x-y-z", "abc123def"}
	for _, u := range valid {
		if err := validateUsername(u); err != nil {
			t.Errorf("expected %q valid, got %v", u, err)
		}
	}

	// Format failures -> ErrInvalid.
	badFormat := []string{
		"", "ab", // too short (<3)
		"-jane", "jane-", // leading/trailing hyphen
		"Jane",      // uppercase (caller must normalize first)
		"jane_doe",  // underscore
		"jane.doe",  // dot
		"jane doe",  // space
		"a", "",     // empty / single char
		"thisusernameiswaytoolongtobevalidasubdomain", // >30
	}
	for _, u := range badFormat {
		if err := validateUsername(u); !errors.Is(err, ErrInvalid) {
			t.Errorf("expected %q -> ErrInvalid, got %v", u, err)
		}
	}

	// Reserved -> ErrConflict.
	for _, u := range []string{"admin", "www", "api", "connect", "support", "dashboard"} {
		if err := validateUsername(u); !errors.Is(err, ErrConflict) {
			t.Errorf("expected reserved %q -> ErrConflict, got %v", u, err)
		}
	}
}

func TestAllowTLSForHost_StaticCases(t *testing.T) {
	// A nil-store AdminService is safe for cases that never reach a tenant
	// lookup (apex/fixed subdomains, and early rejections).
	s := &AdminService{}
	const d = "tiefixy.com"

	allow := []string{"tiefixy.com", "www.tiefixy.com", "admin.tiefixy.com", "connect.tiefixy.com", "TIEFIXY.COM", "admin.tiefixy.com:443"}
	for _, h := range allow {
		if !s.AllowTLSForHost(nil, h, d) {
			t.Errorf("expected allow for %q", h)
		}
	}

	deny := []string{"evil.com", "tiefixy.com.evil.com", "a.b.tiefixy.com", ""}
	for _, h := range deny {
		if s.AllowTLSForHost(nil, h, d) {
			t.Errorf("expected deny for %q", h)
		}
	}

	// No platform domain configured -> never allow.
	if s.AllowTLSForHost(nil, "tiefixy.com", "") {
		t.Error("expected deny when platformDomain is empty")
	}
}

func TestNormalizeUsername(t *testing.T) {
	cases := map[string]string{
		"  Jane ":   "jane",
		"ACME-Sup":  "acme-sup",
		"tech01":    "tech01",
	}
	for in, want := range cases {
		if got := normalizeUsername(in); got != want {
			t.Errorf("normalizeUsername(%q) = %q, want %q", in, got, want)
		}
	}
}

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

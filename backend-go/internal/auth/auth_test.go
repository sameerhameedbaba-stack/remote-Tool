package auth

import (
	"strings"
	"testing"
	"time"
)

func TestHashAndVerifyPassword(t *testing.T) {
	const secret = "correct horse battery staple"
	hash, err := HashPassword(secret)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("unexpected hash format: %q", hash)
	}

	ok, err := VerifyPassword(secret, hash)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !ok {
		t.Fatal("expected password to verify")
	}

	ok, err = VerifyPassword("wrong password", hash)
	if err != nil {
		t.Fatalf("VerifyPassword(wrong): %v", err)
	}
	if ok {
		t.Fatal("expected wrong password to fail")
	}
}

func TestHashPasswordUniqueSalt(t *testing.T) {
	h1, _ := HashPassword("same")
	h2, _ := HashPassword("same")
	if h1 == h2 {
		t.Fatal("expected different hashes due to random salt")
	}
}

func TestVerifyPasswordBadHash(t *testing.T) {
	if _, err := VerifyPassword("x", "not-a-valid-hash"); err == nil {
		t.Fatal("expected error for malformed hash")
	}
}

func TestSessionCodeGenerationAndFormat(t *testing.T) {
	for _, length := range []int{6, 7, 9, 12} {
		code, err := GenerateSessionCode(length)
		if err != nil {
			t.Fatalf("GenerateSessionCode(%d): %v", length, err)
		}
		norm := NormalizeSessionCode(code)
		if len(norm) != length {
			t.Fatalf("length %d: got %d digits (%q)", length, len(norm), code)
		}
		for _, r := range norm {
			if r < '0' || r > '9' {
				t.Fatalf("non-digit in code %q", code)
			}
		}
		// Hyphen grouping: a hyphen after every third digit.
		if length == 9 && strings.Count(code, "-") != 2 {
			t.Fatalf("expected ddd-ddd-ddd grouping, got %q", code)
		}
		if length == 7 && code[3] != '-' {
			t.Fatalf("expected ddd-ddd-d grouping, got %q", code)
		}
	}
}

func TestGenerateSessionCodeRejectsOutOfRange(t *testing.T) {
	if _, err := GenerateSessionCode(3); err == nil {
		t.Fatal("expected error for too-short length")
	}
	if _, err := GenerateSessionCode(20); err == nil {
		t.Fatal("expected error for too-long length")
	}
}

func TestHashSessionCodeIgnoresFormatting(t *testing.T) {
	secret := []byte("test-server-secret")
	if HashSessionCode(secret, "482-193-7") != HashSessionCode(secret, "4821937") {
		t.Fatal("expected formatting-independent hashing")
	}
	if HashSessionCode(secret, "111") == HashSessionCode(secret, "222") {
		t.Fatal("distinct codes must hash differently")
	}
	// A different server secret must yield a different keyed hash for the same code.
	if HashSessionCode(secret, "482-193-7") == HashSessionCode([]byte("other-secret"), "482-193-7") {
		t.Fatal("keyed hash must depend on the server secret")
	}
}

func TestDeviceTokenRoundTrip(t *testing.T) {
	secret, hash, err := NewDeviceSecret()
	if err != nil {
		t.Fatalf("NewDeviceSecret: %v", err)
	}
	token := FormatDeviceToken("dev-123", secret)
	id, gotSecret, err := ParseDeviceToken(token)
	if err != nil {
		t.Fatalf("ParseDeviceToken: %v", err)
	}
	if id != "dev-123" {
		t.Fatalf("device id: got %q", id)
	}
	if gotSecret != secret {
		t.Fatalf("secret mismatch")
	}
	ok, err := VerifyPassword(gotSecret, hash)
	if err != nil || !ok {
		t.Fatalf("device secret should verify: ok=%v err=%v", ok, err)
	}
}

func TestParseDeviceTokenErrors(t *testing.T) {
	for _, bad := range []string{"", "nodot", ".onlysecret", "onlyid."} {
		if _, _, err := ParseDeviceToken(bad); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
}

func TestJWTIssueAndParse(t *testing.T) {
	secret := []byte("this-is-a-32-byte-minimum-secret-value")
	token, expires, err := IssueJWT(secret, "tech-1", "a@b.com", "admin", time.Hour)
	if err != nil {
		t.Fatalf("IssueJWT: %v", err)
	}
	if !expires.After(time.Now()) {
		t.Fatal("expiry should be in the future")
	}
	claims, err := ParseJWT(secret, token)
	if err != nil {
		t.Fatalf("ParseJWT: %v", err)
	}
	if claims.Subject != "tech-1" || claims.Email != "a@b.com" || claims.Role != "admin" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestJWTRejectsWrongSecret(t *testing.T) {
	secret := []byte("this-is-a-32-byte-minimum-secret-value")
	token, _, _ := IssueJWT(secret, "tech-1", "a@b.com", "admin", time.Hour)
	if _, err := ParseJWT([]byte("another-32-byte-minimum-secret-value!"), token); err == nil {
		t.Fatal("expected verification failure with wrong secret")
	}
}

func TestJWTRejectsExpired(t *testing.T) {
	secret := []byte("this-is-a-32-byte-minimum-secret-value")
	token, _, _ := IssueJWT(secret, "tech-1", "a@b.com", "admin", -time.Minute)
	if _, err := ParseJWT(secret, token); err == nil {
		t.Fatal("expected expired token to be rejected")
	}
}

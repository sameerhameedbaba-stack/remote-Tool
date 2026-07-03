// Package auth provides the pure credential primitives used by the backend:
// argon2id password/secret hashing, HS256 JWT issue/parse, device-token
// parsing, and one-time session-code generation. It has no store or network
// dependencies so it is trivially unit-testable.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters. Tuned for interactive auth on a server; memory-hard.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024 // KiB => 64 MiB
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16
)

// ErrInvalidHash is returned when a stored hash string cannot be parsed.
var ErrInvalidHash = errors.New("auth: invalid argon2id hash format")

// HashPassword hashes a secret with argon2id and returns a PHC-formatted string
// (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`) safe to store verbatim.
func HashPassword(secret string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	key := argon2.IDKey([]byte(secret), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword reports whether secret matches the stored PHC hash. The final
// comparison is constant-time to avoid leaking match progress via timing.
func VerifyPassword(secret, encoded string) (bool, error) {
	params, salt, want, err := decodeHash(encoded)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(secret), salt, params.time, params.memory, params.threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

var (
	dummyHashOnce sync.Once
	dummyHash     string
)

// DummyPasswordVerify runs a full argon2id verification against a fixed internal
// hash and discards the result. Call it on the "principal not found" branch of a
// login so that branch performs the same memory-hard work as a real password
// check, removing the timing oracle that would otherwise reveal which
// emails/accounts exist (user enumeration). See SECURITY_REVIEW.md.
func DummyPasswordVerify(password string) {
	dummyHashOnce.Do(func() {
		if h, err := HashPassword("enumeration-guard-not-a-real-credential"); err == nil {
			dummyHash = h
		}
	})
	if dummyHash != "" {
		_, _ = VerifyPassword(password, dummyHash)
	}
}

type argonParams struct {
	memory  uint32
	time    uint32
	threads uint8
}

func decodeHash(encoded string) (argonParams, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	// ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	var p argonParams
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memory, &p.time, &p.threads); err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	hash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	return p, salt, hash, nil
}

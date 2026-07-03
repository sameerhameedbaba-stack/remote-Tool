package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
)

// GenerateSessionCode returns a CSPRNG numeric code of the given length,
// formatted into hyphen-separated groups of three for readability
// (e.g. length 9 => "ddd-ddd-ddd", length 7 => "ddd-ddd-d").
func GenerateSessionCode(length int) (string, error) {
	if length < 6 || length > 12 {
		return "", fmt.Errorf("auth: session code length %d out of range", length)
	}
	digits := make([]byte, length)
	for i := 0; i < length; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", fmt.Errorf("auth: read digit: %w", err)
		}
		digits[i] = byte('0' + n.Int64())
	}
	return groupDigits(string(digits)), nil
}

// groupDigits inserts a hyphen after every third digit.
func groupDigits(digits string) string {
	var b strings.Builder
	for i, d := range digits {
		if i > 0 && i%3 == 0 {
			b.WriteByte('-')
		}
		b.WriteRune(d)
	}
	return b.String()
}

// NormalizeSessionCode strips formatting so equivalent codes hash identically.
// Only digits are retained.
func NormalizeSessionCode(code string) string {
	var b strings.Builder
	for _, r := range code {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// HashSessionCode returns the hex-encoded sha256 of the normalized code. Only
// this hash is stored (in Redis, mapped to the session id).
func HashSessionCode(code string) string {
	sum := sha256.Sum256([]byte(NormalizeSessionCode(code)))
	return hex.EncodeToString(sum[:])
}

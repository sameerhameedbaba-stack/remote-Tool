package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// ErrInvalidDeviceToken is returned when a device token is not of the form
// "<device_id>.<device_secret>".
var ErrInvalidDeviceToken = errors.New("auth: invalid device token")

// deviceSecretBytes is the CSPRNG entropy of a device secret (32 bytes).
const deviceSecretBytes = 32

// NewDeviceSecret returns a fresh URL-safe device secret with 32 bytes of
// entropy, plus its argon2id hash for storage. The plaintext is returned once.
func NewDeviceSecret() (secret, hash string, err error) {
	raw := make([]byte, deviceSecretBytes)
	if _, err = rand.Read(raw); err != nil {
		return "", "", fmt.Errorf("auth: read device secret: %w", err)
	}
	secret = base64.RawURLEncoding.EncodeToString(raw)
	hash, err = HashPassword(secret)
	if err != nil {
		return "", "", err
	}
	return secret, hash, nil
}

// FormatDeviceToken builds the opaque token the agent presents on every call.
func FormatDeviceToken(deviceID, secret string) string {
	return deviceID + "." + secret
}

// ParseDeviceToken splits "<device_id>.<device_secret>" into its parts.
func ParseDeviceToken(token string) (deviceID, secret string, err error) {
	// The device_id is a UUID (no dots); split on the first dot only.
	idx := strings.IndexByte(token, '.')
	if idx <= 0 || idx == len(token)-1 {
		return "", "", ErrInvalidDeviceToken
	}
	return token[:idx], token[idx+1:], nil
}

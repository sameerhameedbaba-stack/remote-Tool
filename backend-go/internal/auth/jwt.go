package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidToken is returned for any malformed, mis-signed, or expired JWT.
var ErrInvalidToken = errors.New("auth: invalid token")

// Claims are the technician JWT claims per docs/API.md. Username is the tenant
// subdomain identifier; Role is `admin` (platform) or `technician`.
type Claims struct {
	Email    string `json:"email"`
	Username string `json:"username"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

// IssueJWT mints an HS256 technician access token valid for ttl.
func IssueJWT(secret []byte, techID, email, username, role string, ttl time.Duration) (string, time.Time, error) {
	now := time.Now()
	expires := now.Add(ttl)
	claims := Claims{
		Email:    email,
		Username: username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   techID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expires),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(secret)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: sign jwt: %w", err)
	}
	return signed, expires, nil
}

// ParseJWT validates an HS256 token against secret and returns its claims.
func ParseJWT(secret []byte, tokenStr string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("%w: unexpected signing method %v", ErrInvalidToken, t.Header["alg"])
		}
		return secret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if claims.Subject == "" {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

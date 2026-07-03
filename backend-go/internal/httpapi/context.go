package httpapi

import (
	"context"
	"net"
	"net/http"

	"github.com/remote-support/backend/internal/auth"
	"github.com/remote-support/backend/internal/model"
)

type ctxKey int

const (
	ctxKeyTech ctxKey = iota
	ctxKeyDevice
	ctxKeyReqID
)

func withTech(ctx context.Context, c *auth.Claims) context.Context {
	return context.WithValue(ctx, ctxKeyTech, c)
}

// techFrom returns the authenticated technician claims, or nil.
func techFrom(ctx context.Context) *auth.Claims {
	c, _ := ctx.Value(ctxKeyTech).(*auth.Claims)
	return c
}

func withDevice(ctx context.Context, d *model.Device) context.Context {
	return context.WithValue(ctx, ctxKeyDevice, d)
}

// deviceFrom returns the authenticated device, or nil.
func deviceFrom(ctx context.Context) *model.Device {
	d, _ := ctx.Value(ctxKeyDevice).(*model.Device)
	return d
}

func withReqID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKeyReqID, id)
}

func reqIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(ctxKeyReqID).(string)
	return id
}

// clientIP returns the real socket peer IP, used both for audit metadata and as
// the rate-limit key on /attended/join and /auth/login.
//
// It deliberately does NOT trust X-Forwarded-For: that header is client-
// controlled, so honoring it would let an attacker rotate the rate-limit key on
// every request and defeat brute-force protection (see SECURITY_REVIEW.md).
// Behind a trusted reverse proxy, parsing XFF from the right using a configured
// trusted-hop count is a roadmap item; until then the socket address is
// authoritative.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

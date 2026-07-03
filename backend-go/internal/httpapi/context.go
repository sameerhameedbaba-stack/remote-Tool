package httpapi

import (
	"context"
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

// clientIP extracts a best-effort client IP for audit metadata.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// First hop is the original client.
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return xff[:i]
			}
		}
		return xff
	}
	host := r.RemoteAddr
	for i := len(host) - 1; i >= 0; i-- {
		if host[i] == ':' {
			return host[:i]
		}
	}
	return host
}

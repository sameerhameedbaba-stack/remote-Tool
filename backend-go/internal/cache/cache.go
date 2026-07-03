// Package cache is the Redis layer: device presence keys (TTL heartbeat) and
// hashed one-time session codes (TTL, single-use via GETDEL).
package cache

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// PresenceTTL is the lifetime of a device presence key; a device is "online"
// while the key exists.
const PresenceTTL = 30 * time.Second

// ErrCodeNotFound is returned when a session code is missing or already used.
var ErrCodeNotFound = errors.New("cache: session code not found")

// Cache wraps a Redis client.
type Cache struct {
	rdb *redis.Client
}

// New parses a redis:// URL and connects.
func New(ctx context.Context, redisURL string) (*Cache, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("cache: parse url: %w", err)
	}
	rdb := redis.NewClient(opts)
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, fmt.Errorf("cache: ping: %w", err)
	}
	return &Cache{rdb: rdb}, nil
}

// Ping checks connectivity (used by /readyz).
func (c *Cache) Ping(ctx context.Context) error {
	return c.rdb.Ping(ctx).Err()
}

// Close releases the client.
func (c *Cache) Close() error { return c.rdb.Close() }

func presenceKey(deviceID string) string { return "presence:device:" + deviceID }
func codeKey(hash string) string         { return "sessioncode:" + hash }

// SetPresence refreshes a device's presence key with PresenceTTL.
func (c *Cache) SetPresence(ctx context.Context, deviceID, status string) error {
	return c.rdb.Set(ctx, presenceKey(deviceID), status, PresenceTTL).Err()
}

// IsOnline reports whether a device presence key currently exists.
func (c *Cache) IsOnline(ctx context.Context, deviceID string) (bool, error) {
	n, err := c.rdb.Exists(ctx, presenceKey(deviceID)).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// PresenceMap returns online status for a batch of device ids using a pipeline.
func (c *Cache) PresenceMap(ctx context.Context, deviceIDs []string) (map[string]bool, error) {
	out := make(map[string]bool, len(deviceIDs))
	if len(deviceIDs) == 0 {
		return out, nil
	}
	pipe := c.rdb.Pipeline()
	cmds := make(map[string]*redis.IntCmd, len(deviceIDs))
	for _, id := range deviceIDs {
		cmds[id] = pipe.Exists(ctx, presenceKey(id))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	for id, cmd := range cmds {
		n, _ := cmd.Result()
		out[id] = n > 0
	}
	return out, nil
}

// StoreSessionCode maps sha256(code) -> session id with ttl, refusing to
// overwrite an existing key (NX). Only the hash is ever stored.
func (c *Cache) StoreSessionCode(ctx context.Context, codeHash, sessionID string, ttl time.Duration) error {
	ok, err := c.rdb.SetNX(ctx, codeKey(codeHash), sessionID, ttl).Result()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("cache: session code collision")
	}
	return nil
}

// RedeemSessionCode atomically fetches and deletes the code mapping (GETDEL),
// guaranteeing single-use. Returns ErrCodeNotFound if absent or already used.
func (c *Cache) RedeemSessionCode(ctx context.Context, codeHash string) (string, error) {
	sessionID, err := c.rdb.GetDel(ctx, codeKey(codeHash)).Result()
	if errors.Is(err, redis.Nil) {
		return "", ErrCodeNotFound
	}
	if err != nil {
		return "", err
	}
	return sessionID, nil
}

// Package ratelimit is a minimal in-process, per-key token-bucket limiter used
// to blunt brute-force against /attended/join. MVP limitation: it is not shared
// across replicas (see docs/SECURITY_MODEL.md §8).
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens   float64
	lastFill time.Time
}

// maxTrackedKeys caps the number of live buckets so the map cannot grow without
// bound. When exceeded, idle (fully-refilled) buckets are pruned on Allow — they
// carry no state a fresh bucket wouldn't reconstruct.
const maxTrackedKeys = 50000

// Limiter is a per-key token bucket. Idle buckets are pruned on Allow once the
// map exceeds maxTrackedKeys, bounding memory even under high key cardinality.
type Limiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	rate     float64 // tokens added per second
	capacity float64 // max tokens (burst)
	maxKeys  int
	now      func() time.Time
}

// New builds a limiter allowing `burst` immediate requests, refilling at
// `perSecond` tokens/second.
func New(perSecond, burst float64) *Limiter {
	return &Limiter{
		buckets:  map[string]*bucket{},
		rate:     perSecond,
		capacity: burst,
		maxKeys:  maxTrackedKeys,
		now:      time.Now,
	}
}

// Allow consumes one token for key, returning false if the bucket is empty.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()

	// Bound memory: if the map is large, drop any bucket that has refilled to
	// capacity (idle) — deleting it is equivalent to never having seen the key.
	if len(l.buckets) >= l.maxKeys {
		for k, b := range l.buckets {
			if k == key {
				continue
			}
			refilled := minFloat(l.capacity, b.tokens+now.Sub(b.lastFill).Seconds()*l.rate)
			if refilled >= l.capacity {
				delete(l.buckets, k)
			}
		}
	}

	b, ok := l.buckets[key]
	if !ok {
		l.buckets[key] = &bucket{tokens: l.capacity - 1, lastFill: now}
		return true
	}
	// Refill based on elapsed time.
	elapsed := now.Sub(b.lastFill).Seconds()
	b.tokens = minFloat(l.capacity, b.tokens+elapsed*l.rate)
	b.lastFill = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

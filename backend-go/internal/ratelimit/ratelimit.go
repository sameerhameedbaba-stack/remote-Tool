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

// evictScanBudget bounds how many buckets a single Allow examines while pruning
// at capacity, keeping Allow amortized ~O(1) instead of scanning the whole map
// under a high-cardinality flood. Map iteration order is randomized, so a
// bounded scan still makes steady eviction progress across calls.
const evictScanBudget = 64

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

	// Bound memory as a true ceiling with amortized ~O(1) work: only when the map
	// is at capacity AND this is a new key do we prune, examining at most
	// evictScanBudget buckets and deleting idle (fully-refilled) ones — deleting
	// an idle bucket is equivalent to never having seen the key. If none in the
	// sampled window are idle, evict one sampled victim so the new key still fits
	// and the map never grows past maxKeys.
	if len(l.buckets) >= l.maxKeys {
		if _, exists := l.buckets[key]; !exists {
			evicted := 0
			scanned := 0
			victim := ""
			for k, b := range l.buckets {
				if k == key {
					continue
				}
				if victim == "" {
					victim = k
				}
				refilled := minFloat(l.capacity, b.tokens+now.Sub(b.lastFill).Seconds()*l.rate)
				if refilled >= l.capacity {
					delete(l.buckets, k)
					evicted++
				}
				scanned++
				if scanned >= evictScanBudget {
					break
				}
			}
			if evicted == 0 && victim != "" {
				delete(l.buckets, victim)
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

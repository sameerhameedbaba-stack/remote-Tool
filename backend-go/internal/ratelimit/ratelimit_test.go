package ratelimit

import (
	"strconv"
	"testing"
	"time"
)

func TestTokenBucketBurstThenDeny(t *testing.T) {
	// No refill (rate 0), burst of 2.
	l := New(0, 2)
	if !l.Allow("ip") {
		t.Fatal("first request should pass")
	}
	if !l.Allow("ip") {
		t.Fatal("second request should pass (burst)")
	}
	if l.Allow("ip") {
		t.Fatal("third request should be denied")
	}
}

func TestTokenBucketRefill(t *testing.T) {
	l := New(100, 1) // refills fast
	base := time.Now()
	l.now = func() time.Time { return base }
	if !l.Allow("ip") {
		t.Fatal("first should pass")
	}
	if l.Allow("ip") {
		t.Fatal("second should be denied immediately")
	}
	// Advance 100ms => 10 tokens refilled (capped at 1).
	l.now = func() time.Time { return base.Add(100 * time.Millisecond) }
	if !l.Allow("ip") {
		t.Fatal("should pass after refill")
	}
}

func TestMapStaysBoundedUnderHighCardinality(t *testing.T) {
	// Small ceiling so the test is fast; every call uses a distinct key.
	l := New(0, 1)
	l.maxKeys = 100
	base := time.Now()
	l.now = func() time.Time { return base }

	for i := 0; i < 10000; i++ {
		l.Allow("k-" + strconv.Itoa(i))
	}
	if len(l.buckets) > l.maxKeys {
		t.Fatalf("bucket map grew past ceiling: len=%d, maxKeys=%d", len(l.buckets), l.maxKeys)
	}
}

func TestPerKeyIsolation(t *testing.T) {
	l := New(0, 1)
	if !l.Allow("a") {
		t.Fatal("key a first should pass")
	}
	if !l.Allow("b") {
		t.Fatal("key b should have its own bucket")
	}
	if l.Allow("a") {
		t.Fatal("key a second should be denied")
	}
}

// BenchmarkAllowHotKey is the steady-state hot path (one repeated source IP).
func BenchmarkAllowHotKey(b *testing.B) {
	l := New(1000, 1000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		l.Allow("10.0.0.1")
	}
}

// BenchmarkAllowAtCapacity is the adversarial path this limiter defends: a
// high-cardinality flood keeping the bucket map at its ceiling. The eviction
// fix must keep Allow near O(1) here rather than degrading to an O(n) scan.
func BenchmarkAllowAtCapacity(b *testing.B) {
	l := New(1, 5)
	for i := 0; i < maxTrackedKeys; i++ { // fill to the ceiling
		l.Allow("seed-" + strconv.Itoa(i))
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		l.Allow("flood-" + strconv.Itoa(i)) // always a new key → forces eviction
	}
}

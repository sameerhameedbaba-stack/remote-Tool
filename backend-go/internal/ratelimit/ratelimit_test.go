package ratelimit

import (
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

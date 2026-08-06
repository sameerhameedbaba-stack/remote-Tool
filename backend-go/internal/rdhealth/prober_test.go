package rdhealth

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestHostFrom(t *testing.T) {
	cases := []struct{ in, want string }{
		{"200.97.171.196", "200.97.171.196"},
		{"200.97.171.196:21116", "200.97.171.196"},
		{"http://200.97.171.196:21114", "200.97.171.196"},
		{"https://rustdesk.example.com", "rustdesk.example.com"},
		{"rustdesk.example.com", "rustdesk.example.com"},
		{"  200.97.171.196  ", "200.97.171.196"},
		{"", ""},
		{"://broken", ""},
	}
	for _, c := range cases {
		if got := hostFrom(c.in); got != c.want {
			t.Errorf("hostFrom(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A prober with no host must be completely inert — Run returns at once and the
// report says disabled. An unconfigured platform still has to boot.
func TestDisabledProberIsInert(t *testing.T) {
	p := New("", "", time.Second, testLogger())
	if p.Enabled() {
		t.Fatal("prober with no host should be disabled")
	}

	done := make(chan struct{})
	go func() { p.Run(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return immediately for a disabled prober")
	}

	rep := p.Report()
	if rep.Enabled || rep.Latest != nil {
		t.Fatalf("disabled report should be empty, got %+v", rep)
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want State
	}{
		{"deadline", context.DeadlineExceeded, StateTimeout},
		{"net timeout", &net.OpError{Err: &timeoutErr{}}, StateTimeout},
		{"refused errno", &net.OpError{Err: syscall.ECONNREFUSED}, StateRefused},
		{"refused text", errors.New("dial tcp 1.2.3.4:21116: connection refused"), StateRefused},
		{"dns", errors.New("no such host"), StateError},
	}
	for _, c := range cases {
		if got := classify(c.err); got != c.want {
			t.Errorf("%s: classify = %q, want %q", c.name, got, c.want)
		}
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string { return "i/o timeout" }
func (timeoutErr) Timeout() bool { return true }

// A sweep against a healthy host records one OK sample per target.
func TestSweepAllOK(t *testing.T) {
	p := New("10.0.0.1", "", time.Minute, testLogger())
	p.dial = func(ctx context.Context, addr string) (net.Conn, error) {
		c, _ := net.Pipe()
		return c, nil
	}
	p.sweep(context.Background())

	rep := p.Report()
	if rep.Latest == nil || !rep.Latest.OK {
		t.Fatalf("expected an OK sample, got %+v", rep.Latest)
	}
	if len(rep.Latest.Results) != len(defaultTargets()) {
		t.Fatalf("expected %d results, got %d", len(defaultTargets()), len(rep.Latest.Results))
	}
	if rep.Summary.Failures != 0 || rep.Summary.OKPercent != 100 {
		t.Fatalf("expected a clean summary, got %+v", rep.Summary)
	}
	if len(rep.Outages) != 0 {
		t.Fatalf("expected no outages, got %+v", rep.Outages)
	}
}

// The rendezvous port being down is the case this whole package exists for:
// the sweep must mark the sample failed and name the port.
func TestSweepRendezvousDown(t *testing.T) {
	p := New("10.0.0.1", "", time.Minute, testLogger())
	p.dial = func(ctx context.Context, addr string) (net.Conn, error) {
		if strings.HasSuffix(addr, ":21116") {
			return nil, &net.OpError{Err: syscall.ECONNREFUSED}
		}
		c, _ := net.Pipe()
		return c, nil
	}
	p.sweep(context.Background())

	rep := p.Report()
	if rep.Latest == nil || rep.Latest.OK {
		t.Fatalf("expected a failed sample, got %+v", rep.Latest)
	}
	var found bool
	for _, r := range rep.Latest.Results {
		if r.Port != 21116 {
			continue
		}
		found = true
		if r.State != StateRefused {
			t.Errorf("21116 state = %q, want %q", r.State, StateRefused)
		}
		if r.Detail == "" {
			t.Error("a failed probe should carry a detail string")
		}
	}
	if !found {
		t.Fatal("no result recorded for port 21116")
	}
	if rep.Summary.LastFailureAt == nil {
		t.Error("summary should record the failure time")
	}
	if len(rep.Outages) != 1 || len(rep.Outages[0].Ports) != 1 || rep.Outages[0].Ports[0] != "rendezvous" {
		t.Fatalf("expected one rendezvous outage, got %+v", rep.Outages)
	}
}

// Contiguous failures collapse into one window; an OK sweep between two
// failures splits them. This is what makes "was it down at 14:32?" answerable.
func TestCollapseOutages(t *testing.T) {
	base := time.Date(2026, 8, 6, 14, 0, 0, 0, time.UTC)
	mk := func(offset int, ok bool, failing string) Sample {
		s := Sample{At: base.Add(time.Duration(offset) * time.Minute), OK: ok}
		st := StateOK
		if !ok {
			st = StateRefused
		}
		s.Results = append(s.Results, Result{Name: failing, Port: 21116, State: st})
		return s
	}
	samples := []Sample{
		mk(0, true, "rendezvous"),
		mk(1, false, "rendezvous"),
		mk(2, false, "rendezvous"),
		mk(3, true, "rendezvous"),
		mk(4, false, "relay"),
	}

	out := collapseOutages(samples)
	if len(out) != 2 {
		t.Fatalf("expected 2 outages, got %d: %+v", len(out), out)
	}
	if out[0].Count != 2 || !out[0].From.Equal(base.Add(time.Minute)) || !out[0].To.Equal(base.Add(2*time.Minute)) {
		t.Errorf("first outage wrong: %+v", out[0])
	}
	if len(out[1].Ports) != 1 || out[1].Ports[0] != "relay" {
		t.Errorf("second outage should name relay, got %+v", out[1])
	}
}

// A port that fails throughout must be listed once, not once per sweep.
func TestCollapseOutagesDedupesPorts(t *testing.T) {
	base := time.Date(2026, 8, 6, 14, 0, 0, 0, time.UTC)
	samples := make([]Sample, 0, 3)
	for i := 0; i < 3; i++ {
		samples = append(samples, Sample{
			At:      base.Add(time.Duration(i) * time.Minute),
			OK:      false,
			Results: []Result{{Name: "rendezvous", Port: 21116, State: StateTimeout}},
		})
	}
	out := collapseOutages(samples)
	if len(out) != 1 {
		t.Fatalf("expected 1 outage, got %d", len(out))
	}
	if len(out[0].Ports) != 1 {
		t.Fatalf("expected the port listed once, got %v", out[0].Ports)
	}
}

// The ring must not grow past the window, or a long-running process leaks.
func TestRecordBoundedByCapacity(t *testing.T) {
	p := New("10.0.0.1", "", time.Hour, testLogger()) // 24h/1h => capacity 24
	if p.capacity != 24 {
		t.Fatalf("capacity = %d, want 24", p.capacity)
	}
	base := time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 100; i++ {
		p.record(Sample{At: base.Add(time.Duration(i) * time.Hour), OK: true})
	}
	p.mu.RLock()
	n := len(p.samples)
	first := p.samples[0].At
	p.mu.RUnlock()

	if n != 24 {
		t.Fatalf("kept %d samples, want 24", n)
	}
	if !first.Equal(base.Add(76 * time.Hour)) {
		t.Fatalf("oldest kept sample = %v, want the 77th", first)
	}
}

func TestBucketizeCoversWindow(t *testing.T) {
	now := time.Date(2026, 8, 6, 14, 32, 0, 0, time.UTC)
	samples := []Sample{
		{At: now.Add(-2 * time.Hour), OK: true},
		{At: now.Add(-2 * time.Hour), OK: false},
		{At: now, OK: true},
		{At: now.Add(-48 * time.Hour), OK: false}, // outside the window, ignored
	}
	buckets := bucketize(samples, now)
	if len(buckets) != bucketCount {
		t.Fatalf("got %d buckets, want %d", len(buckets), bucketCount)
	}
	var total, failed int
	for _, b := range buckets {
		total += b.Total
		failed += b.Failed
	}
	if total != 3 || failed != 1 {
		t.Fatalf("bucket totals = %d/%d, want 3 total and 1 failed", total, failed)
	}
}

func TestIntervalFromEnv(t *testing.T) {
	t.Setenv("RUSTDESK_PROBE_INTERVAL", "")
	if got := IntervalFromEnv(); got != DefaultInterval {
		t.Errorf("empty => %v, want %v", got, DefaultInterval)
	}
	t.Setenv("RUSTDESK_PROBE_INTERVAL", "45s")
	if got := IntervalFromEnv(); got != 45*time.Second {
		t.Errorf("45s => %v", got)
	}
	// Bad values must fall back, never fail boot.
	for _, bad := range []string{"nonsense", "-5s", "0"} {
		t.Setenv("RUSTDESK_PROBE_INTERVAL", bad)
		if got := IntervalFromEnv(); got != DefaultInterval {
			t.Errorf("%q => %v, want the default", bad, got)
		}
	}
}

// Run must stop promptly when its context is cancelled, so shutdown isn't held.
func TestRunStopsOnContextCancel(t *testing.T) {
	p := New("10.0.0.1", "", 50*time.Millisecond, testLogger())
	p.dial = func(ctx context.Context, addr string) (net.Conn, error) {
		c, _ := net.Pipe()
		return c, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	time.Sleep(120 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop on context cancel")
	}
	if p.Report().Summary.Checks == 0 {
		t.Error("expected at least one sweep before cancel")
	}
}

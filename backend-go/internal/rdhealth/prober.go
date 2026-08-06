// Package rdhealth watches the RustDesk engine's *connection* ports from inside
// the VPS and keeps a rolling history of what it saw.
//
// Why this exists: the platform's fleet view talks to the RustDesk Pro web
// console API (port 21114). That API answering happily says nothing about the
// ports a session actually needs — the rendezvous/ID port (21116) that brokers
// the introduction between technician and machine, the NAT-type port (21115),
// and the relay port (21117) that carries the session when a direct path can't
// be made. A technician can hit "Failed to connect via rendezvous server" while
// the console API, /healthz and /readyz are all green.
//
// So this prober opens and immediately closes a TCP connection to each port on
// a fixed interval and records ok / refused / timeout with a timestamp. When a
// technician reports "it failed at 14:32", the operator can look at 14:32 and
// see whether the engine was accepting connections — turning an unfalsifiable
// "sometimes it doesn't work" into a yes/no.
//
// Deliberately NOT part of /readyz: RustDesk is a secondary integration, and a
// blip in it must never mark the backend unhealthy and trigger a container
// restart. Nothing here can fail a request; the worst case is an empty history.
package rdhealth

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// State is the outcome of one TCP probe, ordered from best to worst.
type State string

const (
	// StateOK means the TCP handshake completed: the port is listening and
	// accepting. It does not assert that the service behind it is correct.
	StateOK State = "ok"
	// StateRefused means the host answered with RST — nothing is listening.
	// Typically the process is down or restarting.
	StateRefused State = "refused"
	// StateTimeout means no answer at all within the deadline — usually a
	// firewall dropping packets, or a process too wedged to accept.
	StateTimeout State = "timeout"
	// StateError covers DNS and other dial failures.
	StateError State = "error"
)

// Target is one port worth watching, with the plain-English role it plays so
// the console can explain a failure without the reader knowing port numbers.
type Target struct {
	Name string `json:"name"`
	Port int    `json:"port"`
	Role string `json:"role"`
}

// Result is one target's outcome in one sweep.
type Result struct {
	Name  string `json:"name"`
	Port  int    `json:"port"`
	Role  string `json:"role"`
	State State  `json:"state"`
	MS    int64  `json:"ms"`
	// Detail carries the dial error, trimmed. Empty when State is StateOK.
	Detail string `json:"detail,omitempty"`
}

// Sample is one full sweep across every target.
type Sample struct {
	At      time.Time `json:"at"`
	Results []Result  `json:"results"`
	OK      bool      `json:"ok"`
}

// Outage is a contiguous run of sweeps in which at least one target was not OK.
// This is the unit an operator actually reasons about ("was it down at 14:32?").
type Outage struct {
	From  time.Time `json:"from"`
	To    time.Time `json:"to"`
	Count int       `json:"count"`
	// Ports lists which targets failed during the window, worst-first.
	Ports []string `json:"ports"`
}

// Bucket is a fixed time slice of the window, for rendering a status strip
// without shipping thousands of raw samples to the browser.
type Bucket struct {
	At     time.Time `json:"at"`
	Total  int       `json:"total"`
	Failed int       `json:"failed"`
}

// Summary is the headline: how much of the window was healthy.
type Summary struct {
	WindowHours   int        `json:"window_hours"`
	Checks        int        `json:"checks"`
	Failures      int        `json:"failures"`
	OKPercent     float64    `json:"ok_percent"`
	LastFailureAt *time.Time `json:"last_failure_at,omitempty"`
	Since         *time.Time `json:"since,omitempty"`
}

// Report is the whole read-side view handed to the admin console.
type Report struct {
	Enabled  bool     `json:"enabled"`
	Host     string   `json:"host"`
	Targets  []Target `json:"targets"`
	Interval string   `json:"interval"`
	Latest   *Sample  `json:"latest,omitempty"`
	Summary  Summary  `json:"summary"`
	Outages  []Outage `json:"outages"`
	Buckets  []Bucket `json:"buckets"`
}

// Defaults. The interval is a compromise: frequent enough that a 30-second blip
// is visible, sparse enough that it is a rounding error against the agents
// already re-registering every 15s. dialTimeout is deliberately short — a
// healthy loopback/LAN dial completes in single-digit milliseconds, so anything
// near the timeout is itself the signal.
const (
	DefaultInterval = 30 * time.Second
	dialTimeout     = 4 * time.Second
	windowHours     = 24
	bucketCount     = 96 // 24h in 15-minute slices
	maxOutages      = 50
	maxDetail       = 160
)

// defaultTargets are the ports a RustDesk session depends on, in the order the
// client uses them. 21116 is the one named in the "Failed to connect via
// rendezvous server" error; 21117 matters especially for agents built with
// "Disable TCP listen port", which forces sessions through the relay.
func defaultTargets() []Target {
	return []Target{
		{Name: "nat-test", Port: 21115, Role: "Works out the network type before connecting"},
		{Name: "rendezvous", Port: 21116, Role: "Introduces the technician to the machine"},
		{Name: "relay", Port: 21117, Role: "Carries the session when a direct link can't be made"},
	}
}

// Prober periodically dials the RustDesk ports and remembers the outcomes.
// The zero value is not usable; call New.
type Prober struct {
	host     string
	targets  []Target
	interval time.Duration
	log      *slog.Logger

	// dial is swappable so tests don't need a live socket.
	dial func(ctx context.Context, addr string) (net.Conn, error)

	mu       sync.RWMutex
	samples  []Sample // oldest first, capped to the window
	capacity int
}

// New builds a prober for the given RustDesk host. serverID is the host clients
// are pointed at (RUSTDESK_SERVER_ID); apiURL is used only as a fallback when
// serverID is unset. A prober with no resolvable host is inert: Run returns
// immediately and Report says disabled, so an unconfigured platform still boots.
func New(serverID, apiURL string, interval time.Duration, log *slog.Logger) *Prober {
	host := hostFrom(serverID)
	if host == "" {
		host = hostFrom(apiURL)
	}
	if interval <= 0 {
		interval = DefaultInterval
	}
	capacity := int((windowHours * time.Hour) / interval)
	if capacity < 1 {
		capacity = 1
	}
	return &Prober{
		host:     host,
		targets:  defaultTargets(),
		interval: interval,
		log:      log,
		capacity: capacity,
		samples:  make([]Sample, 0, capacity),
		dial: func(ctx context.Context, addr string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", addr)
		},
	}
}

// IntervalFromEnv reads RUSTDESK_PROBE_INTERVAL, falling back to the default.
// An unparseable or non-positive value falls back rather than failing boot:
// monitoring must never be the reason the platform won't start.
func IntervalFromEnv() time.Duration {
	raw := strings.TrimSpace(os.Getenv("RUSTDESK_PROBE_INTERVAL"))
	if raw == "" {
		return DefaultInterval
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return DefaultInterval
	}
	return d
}

// Enabled reports whether there is a host to probe.
func (p *Prober) Enabled() bool { return p != nil && p.host != "" }

// Run sweeps on a ticker until ctx is cancelled. It probes once immediately so
// the console has data without waiting a full interval. Safe to call in a
// goroutine; it never panics out and never returns an error.
func (p *Prober) Run(ctx context.Context) {
	if !p.Enabled() {
		p.log.Info("rustdesk prober disabled (no server host configured)")
		return
	}
	p.log.Info("rustdesk prober started", "host", p.host, "interval", p.interval.String())

	p.sweep(ctx)

	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.sweep(ctx)
		}
	}
}

// sweep probes every target once and records the sample.
func (p *Prober) sweep(ctx context.Context) {
	s := Sample{At: time.Now().UTC(), Results: make([]Result, 0, len(p.targets)), OK: true}
	for _, t := range p.targets {
		r := p.probe(ctx, t)
		if r.State != StateOK {
			s.OK = false
		}
		s.Results = append(s.Results, r)
	}
	p.record(s)

	if !s.OK {
		// One line per failed sweep: the log is the durable record even if the
		// process restarts and the in-memory ring is lost.
		p.log.Warn("rustdesk ports not fully reachable", "host", p.host, "detail", failedSummary(s))
	}
}

// probe dials one target and classifies the outcome.
func (p *Prober) probe(ctx context.Context, t Target) Result {
	addr := net.JoinHostPort(p.host, strconv.Itoa(t.Port))
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	start := time.Now()
	conn, err := p.dial(dctx, addr)
	ms := time.Since(start).Milliseconds()

	r := Result{Name: t.Name, Port: t.Port, Role: t.Role, MS: ms}
	if err == nil {
		// Close at once: this is a liveness handshake, not a session. Ignoring
		// the close error is intentional — the dial already answered the question.
		_ = conn.Close()
		r.State = StateOK
		return r
	}
	r.State = classify(err)
	r.Detail = truncate(err.Error(), maxDetail)
	return r
}

// classify maps a dial error onto a state an operator can act on.
func classify(err error) State {
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return StateTimeout
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return StateTimeout
	}
	if errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(err.Error(), "connection refused") {
		return StateRefused
	}
	return StateError
}

// record appends a sample, dropping the oldest once the window is full.
func (p *Prober) record(s Sample) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.samples = append(p.samples, s)
	if len(p.samples) > p.capacity {
		// Copy down rather than reslice, so the backing array can't grow without
		// bound over a long-running process.
		n := copy(p.samples, p.samples[len(p.samples)-p.capacity:])
		p.samples = p.samples[:n]
	}
}

// Report builds the read-side view. Cheap enough to call per request.
func (p *Prober) Report() Report {
	rep := Report{
		Enabled:  p.Enabled(),
		Host:     p.host,
		Targets:  p.targets,
		Interval: p.interval.String(),
		Outages:  []Outage{},
		Buckets:  []Bucket{},
		Summary:  Summary{WindowHours: windowHours},
	}
	if !p.Enabled() {
		return rep
	}

	p.mu.RLock()
	samples := make([]Sample, len(p.samples))
	copy(samples, p.samples)
	p.mu.RUnlock()

	if len(samples) == 0 {
		return rep
	}

	latest := samples[len(samples)-1]
	rep.Latest = &latest
	rep.Summary.Checks = len(samples)
	since := samples[0].At
	rep.Summary.Since = &since

	var lastFailure *time.Time
	for i := range samples {
		if !samples[i].OK {
			rep.Summary.Failures++
			at := samples[i].At
			lastFailure = &at
		}
	}
	rep.Summary.LastFailureAt = lastFailure
	rep.Summary.OKPercent = round1(float64(rep.Summary.Checks-rep.Summary.Failures) / float64(rep.Summary.Checks) * 100)

	rep.Outages = collapseOutages(samples)
	rep.Buckets = bucketize(samples, latest.At)
	return rep
}

// collapseOutages turns runs of failing sweeps into windows. Only the most
// recent maxOutages are kept — an operator investigating "it failed at 14:32"
// cares about recent history, and an unbounded list would grow the response.
func collapseOutages(samples []Sample) []Outage {
	out := []Outage{}
	var cur *Outage
	seen := map[string]bool{}

	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
			seen = map[string]bool{}
		}
	}
	for _, s := range samples {
		if s.OK {
			flush()
			continue
		}
		if cur == nil {
			cur = &Outage{From: s.At, Ports: []string{}}
		}
		cur.To = s.At
		cur.Count++
		for _, r := range s.Results {
			if r.State == StateOK || seen[r.Name] {
				continue
			}
			seen[r.Name] = true
			cur.Ports = append(cur.Ports, r.Name)
		}
	}
	flush()

	if len(out) > maxOutages {
		out = out[len(out)-maxOutages:]
	}
	return out
}

// bucketize compresses the window into fixed slices for the status strip.
// Buckets run oldest to newest and end at now, so the strip's right edge is
// always "just now" regardless of how long the process has been up.
func bucketize(samples []Sample, now time.Time) []Bucket {
	width := time.Duration(windowHours) * time.Hour / bucketCount
	// Anchor on the END of the window so the newest sample always lands in the
	// last bucket. Truncating the start instead pushes "now" one slot past the
	// end and silently drops it — the one sample the operator is looking at.
	end := now.Truncate(width).Add(width)
	start := end.Add(-time.Duration(windowHours) * time.Hour)

	buckets := make([]Bucket, bucketCount)
	for i := range buckets {
		buckets[i] = Bucket{At: start.Add(time.Duration(i) * width)}
	}
	for _, s := range samples {
		idx := int(s.At.Sub(start) / width)
		if idx < 0 || idx >= bucketCount {
			continue
		}
		buckets[idx].Total++
		if !s.OK {
			buckets[idx].Failed++
		}
	}
	return buckets
}

// failedSummary renders the failing targets of a sweep for one log line.
func failedSummary(s Sample) string {
	parts := make([]string, 0, len(s.Results))
	for _, r := range s.Results {
		if r.State == StateOK {
			continue
		}
		parts = append(parts, r.Name+":"+strconv.Itoa(r.Port)+"="+string(r.State))
	}
	return strings.Join(parts, " ")
}

// hostFrom extracts a bare hostname from a config value that may be a plain
// host, a host:port, or a full URL. Returns "" when nothing usable is present.
func hostFrom(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if strings.Contains(s, "://") {
		if u, err := url.Parse(s); err == nil && u.Hostname() != "" {
			return u.Hostname()
		}
		return ""
	}
	if h, _, err := net.SplitHostPort(s); err == nil && h != "" {
		return h
	}
	// A bare IPv6 literal would have failed SplitHostPort; strip any brackets.
	return strings.Trim(s, "[]")
}

func round1(f float64) float64 {
	return float64(int64(f*10+0.5)) / 10
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

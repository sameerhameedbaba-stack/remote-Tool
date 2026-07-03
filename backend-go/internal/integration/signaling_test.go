//go:build integration

package integration

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// TestSignalingFullHandshake drives the WebSocket signaling path end to end:
// agent connects, receives session-control:start, acks the banner (activating
// the session), then technician and agent exchange offer/answer/ICE through the
// relay. It also asserts the session cannot be active without the banner ack and
// that foreign-session envelopes are dropped.
func TestSignalingFullHandshake(t *testing.T) {
	devID, devTok := app.enrollDevice(t, "SIGNAL-01")
	app.heartbeat(t, devTok)

	// Agent connects its signaling socket first.
	agentWS := app.dialWS(t, "/ws/agent?token="+urlEncode(devTok))
	defer agentWS.CloseNow()

	// Technician starts an unattended session.
	code, sbody := app.doJSON(t, http.MethodPost, "/api/v1/sessions", app.techToken, map[string]string{"device_id": devID})
	if code != http.StatusCreated {
		t.Fatalf("create session: want 201, got %d", code)
	}
	sid := asMap(sbody["session"])["id"].(string)

	// The agent must receive session-control:start for this session.
	env, ok := readEnvelope(agentWS, 3*time.Second)
	if !ok {
		t.Fatal("agent did not receive session-control:start")
	}
	if env.Type != "session-control" || env.SessionID != sid {
		t.Fatalf("unexpected first envelope: %+v", env)
	}
	var ctrl struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal(env.Payload, &ctrl)
	if ctrl.Action != "start" {
		t.Fatalf("want action=start, got %q", ctrl.Action)
	}

	// Before the banner ack the session must still be pending.
	if got := app.sessionStatus(t, sid); got != "pending" {
		t.Fatalf("session should be pending before banner ack, got %q", got)
	}

	// Agent acks the mandatory banner → session activates.
	writeEnvelope(t, agentWS, wsEnvelope{Type: "banner", SessionID: sid, Payload: json.RawMessage(`{"visible":true}`)})
	if !waitFor(3*time.Second, func() bool { return app.sessionStatus(t, sid) == "active" }) {
		t.Fatal("session did not become active after banner ack")
	}

	// session.start must have been audited.
	if !app.auditHas(t, sid, "session.start") {
		t.Fatal("session.start audit record missing after activation")
	}

	// Technician connects its signaling socket for this session.
	techWS := app.dialWS(t, "/ws/signal?session_id="+sid+"&token="+urlEncode(app.techToken))
	defer techWS.CloseNow()

	// tech → agent: offer is relayed.
	writeEnvelope(t, techWS, wsEnvelope{Type: "offer", SessionID: sid, Payload: json.RawMessage(`{"type":"offer","sdp":"v=0-test-offer"}`)})
	got, ok := readEnvelope(agentWS, 3*time.Second)
	if !ok || got.Type != "offer" || got.SessionID != sid {
		t.Fatalf("agent did not receive relayed offer, got %+v (ok=%v)", got, ok)
	}

	// agent → tech: answer is relayed. (The tech may first receive a buffered
	// banner envelope from activation, so read until the answer.)
	writeEnvelope(t, agentWS, wsEnvelope{Type: "answer", SessionID: sid, Payload: json.RawMessage(`{"type":"answer","sdp":"v=0-test-answer"}`)})
	got, ok = readEnvelopeOfType(techWS, "answer", 3*time.Second)
	if !ok || got.SessionID != sid {
		t.Fatalf("tech did not receive relayed answer, got %+v (ok=%v)", got, ok)
	}

	// tech → agent: ICE candidate is relayed.
	writeEnvelope(t, techWS, wsEnvelope{Type: "ice-candidate", SessionID: sid, Payload: json.RawMessage(`{"candidate":"c=1"}`)})
	got, ok = readEnvelope(agentWS, 3*time.Second)
	if !ok || got.Type != "ice-candidate" {
		t.Fatalf("agent did not receive relayed ICE candidate, got %+v (ok=%v)", got, ok)
	}

	// Isolation: a tech envelope carrying a FOREIGN session_id must be dropped
	// (never relayed to this or any agent).
	writeEnvelope(t, techWS, wsEnvelope{Type: "offer", SessionID: "00000000-0000-0000-0000-000000000000", Payload: json.RawMessage(`{"type":"offer","sdp":"evil"}`)})
	if _, ok := readEnvelope(agentWS, 800*time.Millisecond); ok {
		t.Fatal("agent received an envelope for a foreign session (isolation breach)")
	}

	// Clean up: end the session.
	_, _ = app.doJSON(t, http.MethodPost, "/api/v1/sessions/"+sid+"/end", app.techToken, nil)
}

// TestAgentReconnectResumesPendingStart verifies that if the agent connects
// AFTER the session is created, it still receives session-control:start (the
// handler re-issues it from the open-session lookup).
func TestAgentReconnectResumesPendingStart(t *testing.T) {
	devID, devTok := app.enrollDevice(t, "SIGNAL-RECONNECT")
	app.heartbeat(t, devTok)

	code, sbody := app.doJSON(t, http.MethodPost, "/api/v1/sessions", app.techToken, map[string]string{"device_id": devID})
	if code != http.StatusCreated {
		t.Fatalf("create session: want 201, got %d", code)
	}
	sid := asMap(sbody["session"])["id"].(string)

	// Connect the agent only now.
	agentWS := app.dialWS(t, "/ws/agent?token="+urlEncode(devTok))
	defer agentWS.CloseNow()

	env, ok := readEnvelope(agentWS, 3*time.Second)
	if !ok || env.Type != "session-control" || env.SessionID != sid {
		t.Fatalf("agent did not receive resumed start, got %+v (ok=%v)", env, ok)
	}
	_, _ = app.doJSON(t, http.MethodPost, "/api/v1/sessions/"+sid+"/end", app.techToken, nil)
}

// TestSignalingBuffersOfferForLateTech verifies the race fix: if the agent
// produces its offer BEFORE the technician's signaling socket connects, the
// backend buffers it and delivers it when the technician connects (rather than
// dropping it). This is what makes the real WebRTC handshake reliable.
func TestSignalingBuffersOfferForLateTech(t *testing.T) {
	devID, devTok := app.enrollDevice(t, "SIGNAL-BUFFER")
	app.heartbeat(t, devTok)

	agentWS := app.dialWS(t, "/ws/agent?token="+urlEncode(devTok))
	defer agentWS.CloseNow()

	code, sbody := app.doJSON(t, http.MethodPost, "/api/v1/sessions", app.techToken, map[string]string{"device_id": devID})
	if code != http.StatusCreated {
		t.Fatalf("create session: want 201, got %d", code)
	}
	sid := asMap(sbody["session"])["id"].(string)

	// Drain the session-control:start and ack the banner (activates the session).
	if env, ok := readEnvelope(agentWS, 3*time.Second); !ok || env.Type != "session-control" {
		t.Fatalf("expected start, got %+v (ok=%v)", env, ok)
	}
	writeEnvelope(t, agentWS, wsEnvelope{Type: "banner", SessionID: sid, Payload: json.RawMessage(`{"visible":true}`)})

	// Agent sends its OFFER now, while NO technician is connected. The backend
	// must buffer it.
	writeEnvelope(t, agentWS, wsEnvelope{Type: "offer", SessionID: sid, Payload: json.RawMessage(`{"type":"offer","sdp":"v=0-buffered"}`)})

	// Give the backend a moment to route+buffer, then connect the technician.
	time.Sleep(200 * time.Millisecond)
	techWS := app.dialWS(t, "/ws/signal?session_id="+sid+"&token="+urlEncode(app.techToken))
	defer techWS.CloseNow()

	// The technician must receive the buffered offer (possibly after a buffered
	// banner envelope). Read until we see the offer.
	sawOffer := false
	for i := 0; i < 4 && !sawOffer; i++ {
		env, ok := readEnvelope(techWS, 3*time.Second)
		if !ok {
			break
		}
		if env.Type == "offer" && env.SessionID == sid {
			sawOffer = true
		}
	}
	if !sawOffer {
		t.Fatal("late-connecting technician did not receive the buffered offer")
	}
	_, _ = app.doJSON(t, http.MethodPost, "/api/v1/sessions/"+sid+"/end", app.techToken, nil)
}

// ---- helpers used by signaling tests ----

func (a *testApp) sessionStatus(t *testing.T, sid string) string {
	t.Helper()
	_, body := a.doJSON(t, http.MethodGet, "/api/v1/sessions/"+sid, a.techToken, nil)
	s, _ := body["status"].(string)
	return s
}

func (a *testApp) auditHas(t *testing.T, sid, eventType string) bool {
	t.Helper()
	return waitFor(2*time.Second, func() bool {
		_, body := a.doJSON(t, http.MethodGet, "/api/v1/audit?event_type="+eventType+"&session_id="+sid, a.techToken, nil)
		return len(asList(body["events"])) > 0
	})
}

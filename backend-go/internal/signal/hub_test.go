package signal

import (
	"io"
	"log/slog"
	"testing"
)

func testHub() *Hub {
	return NewHub(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func recv(p *Peer) bool {
	select {
	case <-p.Out:
		return true
	default:
		return false
	}
}

func TestRouteTechToAgent(t *testing.T) {
	h := testHub()
	agent := NewPeer("agent")
	tech := NewPeer("tech")
	h.RegisterAgent("dev-1", agent)
	h.RegisterTech("sess-1", "dev-1", tech)

	// In-session envelope reaches the agent.
	h.RouteFromTech("sess-1", Envelope{Type: TypeOffer, SessionID: "sess-1"}, []byte("x"))
	if !recv(agent) {
		t.Fatal("agent should receive in-session envelope")
	}

	// Envelope for a foreign session is dropped.
	h.RouteFromTech("sess-1", Envelope{Type: TypeOffer, SessionID: "sess-OTHER"}, []byte("x"))
	if recv(agent) {
		t.Fatal("agent must not receive foreign-session envelope")
	}
}

func TestRouteAgentToTech(t *testing.T) {
	h := testHub()
	agent := NewPeer("agent")
	tech := NewPeer("tech")
	h.RegisterAgent("dev-1", agent)
	h.RegisterTech("sess-1", "dev-1", tech)

	h.RouteFromAgent("dev-1", Envelope{Type: TypeAnswer, SessionID: "sess-1"}, []byte("x"))
	if !recv(tech) {
		t.Fatal("tech should receive in-session envelope")
	}

	// Agent for a different device cannot inject into this session.
	h.RouteFromAgent("dev-EVIL", Envelope{Type: TypeAnswer, SessionID: "sess-1"}, []byte("x"))
	if recv(tech) {
		t.Fatal("tech must not receive envelope from foreign device")
	}

	// Unknown session is dropped.
	h.RouteFromAgent("dev-1", Envelope{Type: TypeAnswer, SessionID: "sess-UNKNOWN"}, []byte("x"))
	if recv(tech) {
		t.Fatal("tech must not receive envelope for unknown session")
	}
}

func TestSendToAgentAndTech(t *testing.T) {
	h := testHub()
	agent := NewPeer("agent")
	h.RegisterAgent("dev-1", agent)
	h.BindSession("sess-1", "dev-1")

	if !h.SendToAgent("dev-1", ControlEnvelope("sess-1", "start")) {
		t.Fatal("SendToAgent should succeed for connected agent")
	}
	if !recv(agent) {
		t.Fatal("agent should receive control envelope")
	}
	if h.SendToAgent("dev-absent", ControlEnvelope("sess-1", "start")) {
		t.Fatal("SendToAgent should report false for absent agent")
	}
}

// Package signal is the in-memory WebSocket signaling hub. It binds technician
// and agent sockets to sessions and relays SDP/ICE/session-control/banner
// envelopes to the opposite peer, dropping envelopes whose session the sender
// is not a party to. Media and data channels never traverse this hub.
//
// MVP limitation: the hub is single-instance (see docs/SECURITY_MODEL.md §8).
package signal

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// Envelope is the newline-free JSON message exchanged on both sockets.
type Envelope struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// Envelope type constants.
const (
	TypeOffer          = "offer"
	TypeAnswer         = "answer"
	TypeICECandidate   = "ice-candidate"
	TypeSessionControl = "session-control"
	TypeBanner         = "banner"
	TypeError          = "error"
)

// outboundBuffer bounds per-peer queued messages before slow-consumer drop.
const outboundBuffer = 32

// ControlEnvelope builds a session-control envelope with the given action
// (start|end|approve).
func ControlEnvelope(sessionID, action string) Envelope {
	payload, _ := json.Marshal(map[string]string{"action": action})
	return Envelope{Type: TypeSessionControl, SessionID: sessionID, Payload: payload}
}

// BannerEnvelope builds a banner:visible envelope.
func BannerEnvelope(sessionID string) Envelope {
	payload, _ := json.Marshal(map[string]bool{"visible": true})
	return Envelope{Type: TypeBanner, SessionID: sessionID, Payload: payload}
}

// Peer is one connected socket. Out is drained by the socket's write pump.
type Peer struct {
	// ID is the deviceID (agent) or sessionID (technician); informational.
	ID  string
	Out chan []byte
}

// NewPeer creates a peer with a buffered outbound queue.
func NewPeer(id string) *Peer {
	return &Peer{ID: id, Out: make(chan []byte, outboundBuffer)}
}

// Hub tracks agent and technician peers and the session→device binding.
type Hub struct {
	mu       sync.RWMutex
	agents   map[string]*Peer  // deviceID -> agent socket
	techs    map[string]*Peer  // sessionID -> technician socket
	sessions map[string]string // sessionID -> deviceID (party binding)
	log      *slog.Logger
}

// NewHub builds an empty hub.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{
		agents:   map[string]*Peer{},
		techs:    map[string]*Peer{},
		sessions: map[string]string{},
		log:      log,
	}
}

// BindSession records which device a session belongs to. Called on session
// creation so routing and the session-control:start push work immediately.
func (h *Hub) BindSession(sessionID, deviceID string) {
	h.mu.Lock()
	h.sessions[sessionID] = deviceID
	h.mu.Unlock()
}

// UnbindSession forgets a session (called on end).
func (h *Hub) UnbindSession(sessionID string) {
	h.mu.Lock()
	delete(h.sessions, sessionID)
	h.mu.Unlock()
}

// RegisterAgent attaches an agent socket for a device.
func (h *Hub) RegisterAgent(deviceID string, p *Peer) {
	h.mu.Lock()
	h.agents[deviceID] = p
	h.mu.Unlock()
}

// UnregisterAgent detaches an agent socket if it is still the current one.
func (h *Hub) UnregisterAgent(deviceID string, p *Peer) {
	h.mu.Lock()
	if h.agents[deviceID] == p {
		delete(h.agents, deviceID)
	}
	h.mu.Unlock()
}

// RegisterTech attaches a technician socket for a session. It binds the session
// to a device only when a device id is known (attended sessions bind at join).
func (h *Hub) RegisterTech(sessionID, deviceID string, p *Peer) {
	h.mu.Lock()
	h.techs[sessionID] = p
	if deviceID != "" {
		h.sessions[sessionID] = deviceID
	}
	h.mu.Unlock()
}

// UnregisterTech detaches a technician socket if it is still the current one.
func (h *Hub) UnregisterTech(sessionID string, p *Peer) {
	h.mu.Lock()
	if h.techs[sessionID] == p {
		delete(h.techs, sessionID)
	}
	h.mu.Unlock()
}

// sessionDevice returns the device bound to a session.
func (h *Hub) sessionDevice(sessionID string) (string, bool) {
	h.mu.RLock()
	d, ok := h.sessions[sessionID]
	h.mu.RUnlock()
	return d, ok
}

// RouteFromTech relays a technician envelope to that session's agent. It drops
// envelopes whose session_id does not match the socket's bound session.
func (h *Hub) RouteFromTech(boundSessionID string, env Envelope, raw []byte) {
	if env.SessionID != boundSessionID {
		h.log.Warn("dropping tech envelope for foreign session",
			"bound", boundSessionID, "got", env.SessionID, "type", env.Type)
		return
	}
	deviceID, ok := h.sessionDevice(boundSessionID)
	if !ok {
		return
	}
	h.mu.RLock()
	agent := h.agents[deviceID]
	h.mu.RUnlock()
	if agent == nil {
		h.log.Debug("no agent socket for session", "session_id", boundSessionID)
		return
	}
	trySend(agent, raw, h.log)
}

// RouteFromAgent relays an agent envelope to the session's technician. It drops
// envelopes for sessions not bound to this agent's device.
func (h *Hub) RouteFromAgent(agentDeviceID string, env Envelope, raw []byte) {
	deviceID, ok := h.sessionDevice(env.SessionID)
	if !ok || deviceID != agentDeviceID {
		h.log.Warn("dropping agent envelope for foreign session",
			"device", agentDeviceID, "session_id", env.SessionID, "type", env.Type)
		return
	}
	h.mu.RLock()
	tech := h.techs[env.SessionID]
	h.mu.RUnlock()
	if tech == nil {
		h.log.Debug("no tech socket for session", "session_id", env.SessionID)
		return
	}
	trySend(tech, raw, h.log)
}

// SendToAgent pushes a server-originated envelope (e.g. session-control:start)
// to a device's agent socket. Returns false if the agent is not connected.
func (h *Hub) SendToAgent(deviceID string, env Envelope) bool {
	h.mu.RLock()
	agent := h.agents[deviceID]
	h.mu.RUnlock()
	if agent == nil {
		return false
	}
	raw, err := json.Marshal(env)
	if err != nil {
		h.log.Error("marshal server envelope", "err", err)
		return false
	}
	return trySend(agent, raw, h.log)
}

// SendToTech pushes a server-originated envelope to a session's technician
// socket. Returns false if the technician is not connected.
func (h *Hub) SendToTech(sessionID string, env Envelope) bool {
	h.mu.RLock()
	tech := h.techs[sessionID]
	h.mu.RUnlock()
	if tech == nil {
		return false
	}
	raw, err := json.Marshal(env)
	if err != nil {
		h.log.Error("marshal server envelope", "err", err)
		return false
	}
	return trySend(tech, raw, h.log)
}

// trySend does a non-blocking enqueue; a full queue means a slow/dead consumer
// and the message is dropped rather than blocking the hub.
func trySend(p *Peer, raw []byte, log *slog.Logger) bool {
	select {
	case p.Out <- raw:
		return true
	default:
		log.Warn("dropping message: peer outbound queue full", "peer", p.ID)
		return false
	}
}

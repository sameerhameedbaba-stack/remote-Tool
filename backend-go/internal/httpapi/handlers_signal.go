package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/coder/websocket"
	"github.com/remote-support/backend/internal/auth"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/service"
	"github.com/remote-support/backend/internal/signal"
)

const (
	wsReadLimit = 1 << 20 // 1 MiB per signaling envelope
	wsWriteWait = 10 * time.Second
)

// handleSignalWS is the technician signaling socket. JWT via ?token= or header.
func (s *Server) handleSignalWS(w http.ResponseWriter, r *http.Request) {
	tokenStr := bearerToken(r)
	if tokenStr == "" {
		tokenStr = r.URL.Query().Get("token")
	}
	if tokenStr == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing token")
		return
	}
	claims, err := auth.ParseJWT(s.cfg.JWTSecret, tokenStr)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or expired token")
		return
	}

	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "session_id is required")
		return
	}
	sess, err := s.svcs.Session.Get(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "session not found")
			return
		}
		writeServiceError(w, s.log, err)
		return
	}
	// Authorization: the connecting technician must own this session. Binding by
	// session_id alone would let any authenticated technician attach to (and be
	// mis-attributed on) a session that is not theirs. Reject before upgrading.
	if sess.TechnicianID == nil || claims.Subject != *sess.TechnicianID {
		writeError(w, http.StatusForbidden, "forbidden", "not permitted")
		return
	}

	c, err := s.acceptWS(w, r)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(wsReadLimit)

	deviceID := ""
	if sess.DeviceID != nil {
		deviceID = *sess.DeviceID
	}
	peer := signal.NewPeer("tech:" + sessionID)
	s.hub.RegisterTech(sessionID, deviceID, peer)
	defer s.hub.UnregisterTech(sessionID, peer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.writePump(ctx, c, peer)

	for {
		env, raw, err := readEnvelope(ctx, c)
		if err != nil {
			return
		}
		s.hub.RouteFromTech(sessionID, env, raw)
	}
}

// handleAgentWS is the agent signaling socket, authenticated by device token.
func (s *Server) handleAgentWS(w http.ResponseWriter, r *http.Request) {
	tokenStr := bearerToken(r)
	if tokenStr == "" {
		tokenStr = r.URL.Query().Get("token")
	}
	if tokenStr == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing device token")
		return
	}
	device, err := s.svcs.Auth.VerifyDeviceToken(r.Context(), tokenStr)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "invalid device token")
		return
	}

	c, err := s.acceptWS(w, r)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(wsReadLimit)

	peer := signal.NewPeer("agent:" + device.ID)
	s.hub.RegisterAgent(device.ID, peer)
	defer s.hub.UnregisterAgent(device.ID, peer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.writePump(ctx, c, peer)

	// If a session is already pending for this device (created while the socket
	// was down), re-issue session-control:start so the agent shows the banner.
	if sess, err := s.svcs.Agent.OpenSessionForDevice(ctx, device.ID); err == nil &&
		sess != nil && sess.Status == model.SessionStatusPending {
		s.hub.SendToAgent(device.ID, s.svcs.Session.StartControlEnvelope(ctx, sess))
	}

	for {
		env, raw, err := readEnvelope(ctx, c)
		if err != nil {
			return
		}
		if env.Type == signal.TypeBanner {
			// The agent confirms the mandatory banner is visible; activate the
			// session. ActivateFromBanner notifies the technician itself.
			if bannerVisible(env.Payload) {
				if err := s.svcs.Session.ActivateFromBanner(ctx, env.SessionID, device.ID); err != nil {
					// Activation (incl. the session.start audit write) failed.
					// Do not let an unaudited/un-activated session proceed: tell
					// both peers to end and close the agent socket.
					s.log.Warn("banner activation failed; ending session", "session_id", env.SessionID, "err", err)
					s.hub.SendToAgent(device.ID, signal.ControlEnvelope(env.SessionID, "end"))
					s.hub.SendToTech(env.SessionID, signal.ControlEnvelope(env.SessionID, "end"))
					return
				}
			}
			continue
		}
		s.hub.RouteFromAgent(device.ID, env, raw)
	}
}

// acceptWS upgrades the connection, restricting browser origins to the console.
func (s *Server) acceptWS(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	opts := &websocket.AcceptOptions{}
	if host := originHost(s.cfg.CORSAllowedOrigin); host != "" {
		opts.OriginPatterns = []string{host}
	}
	c, err := websocket.Accept(w, r, opts)
	if err != nil {
		s.log.Warn("ws accept failed", "err", err)
		return nil, err
	}
	return c, nil
}

// writePump drains a peer's outbound queue to the socket.
func (s *Server) writePump(ctx context.Context, c *websocket.Conn, peer *signal.Peer) {
	for {
		select {
		case <-ctx.Done():
			return
		case raw, ok := <-peer.Out:
			if !ok {
				return
			}
			wctx, cancel := context.WithTimeout(ctx, wsWriteWait)
			err := c.Write(wctx, websocket.MessageText, raw)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// readEnvelope reads and parses one text envelope.
func readEnvelope(ctx context.Context, c *websocket.Conn) (signal.Envelope, []byte, error) {
	typ, data, err := c.Read(ctx)
	if err != nil {
		return signal.Envelope{}, nil, err
	}
	if typ != websocket.MessageText {
		// Skip binary frames; return an empty envelope the caller will drop.
		return signal.Envelope{}, data, nil
	}
	var env signal.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return signal.Envelope{}, data, nil // malformed: caller drops (session_id empty)
	}
	return env, data, nil
}

func bannerVisible(payload json.RawMessage) bool {
	var p struct {
		Visible bool `json:"visible"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.Visible
}

// originHost extracts host[:port] from a configured origin URL.
func originHost(origin string) string {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Host
}

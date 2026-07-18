package service

import (
	"context"
	"errors"
	"log/slog"
	"sort"

	"github.com/remote-support/backend/internal/rustdesk"
)

// FleetService surfaces the RustDesk-managed fleet (the machines that ran the
// branded client) into each technician's panel, scoped to that technician.
//
// Tenant isolation: branded clients are tagged into a RustDesk group equal to
// the technician's username, so a technician only ever sees their own machines.
// The platform admin (no scoping) sees everything.
type FleetService struct {
	rd  *rustdesk.Client
	log *slog.Logger
}

// FleetMember is one machine shown in a panel, combining RustDesk presence with
// the connection info the console needs to launch a session.
type FleetMember struct {
	RustDeskID string `json:"rustdesk_id"`
	Hostname   string `json:"hostname"`
	Username   string `json:"username"`
	OS         string `json:"os"`
	Online     bool   `json:"online"`
	LastSeen   string `json:"last_seen,omitempty"`
}

// ListForTechnician returns the fleet visible to a technician. group is the
// technician's username (empty for the platform admin => whole fleet). When the
// RustDesk API is not configured yet, it returns an empty list rather than an
// error so the panel still renders.
func (s *FleetService) ListForTechnician(ctx context.Context, group string) ([]FleetMember, error) {
	peers, err := s.rd.ListPeers(ctx, group)
	if err != nil {
		if errors.Is(err, rustdesk.ErrNotConfigured) {
			return []FleetMember{}, nil
		}
		return nil, err
	}
	out := make([]FleetMember, 0, len(peers))
	for _, p := range peers {
		out = append(out, FleetMember{
			RustDeskID: p.ID,
			Hostname:   p.Hostname,
			Username:   p.Username,
			OS:         p.OS,
			Online:     p.Online,
			LastSeen:   p.LastSeen,
		})
	}
	// Online first, then by hostname, so the panel reads naturally.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Online != out[j].Online {
			return out[i].Online
		}
		return out[i].Hostname < out[j].Hostname
	})
	return out, nil
}

// Enabled reports whether the RustDesk fleet integration is live.
func (s *FleetService) Enabled() bool { return s.rd != nil && s.rd.Configured() }

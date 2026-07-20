package service

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"strings"

	"github.com/remote-support/backend/internal/rustdesk"
	"github.com/remote-support/backend/internal/store"
)

// FleetService surfaces the RustDesk-managed fleet (the machines that ran the
// branded client) into each technician's panel, scoped to that technician, and
// lets them rename (platform-side alias) or delete (hide + best-effort remove
// from RustDesk) a machine.
//
// Tenant isolation: branded clients are tagged into a RustDesk group equal to
// the technician's username, so a technician only ever sees/manages their own
// machines. The platform admin (no scoping) sees everything.
type FleetService struct {
	rd    *rustdesk.Client
	store *store.Store
	log   *slog.Logger
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
// technician's username (empty for the platform admin => whole fleet). Applies
// platform overrides: a custom alias replaces the display name, and hidden
// (deleted) machines are omitted. Returns [] (not an error) when RustDesk is
// unconfigured so the panel still renders.
func (s *FleetService) ListForTechnician(ctx context.Context, group string) ([]FleetMember, error) {
	peers, err := s.rd.ListPeers(ctx, group)
	if err != nil {
		if errors.Is(err, rustdesk.ErrNotConfigured) {
			return []FleetMember{}, nil
		}
		return nil, err
	}
	overrides, err := s.store.ListDeviceOverrides(ctx)
	if err != nil {
		// Overrides are a nicety; don't fail the whole list if they can't load.
		s.log.Warn("load device overrides failed", "err", err)
		overrides = map[string]store.DeviceOverride{}
	}

	out := make([]FleetMember, 0, len(peers))
	for _, p := range peers {
		ov := overrides[p.ID]
		if ov.Hidden {
			continue // deleted from the dashboard
		}
		hostname := p.Hostname
		if ov.Alias != "" {
			hostname = ov.Alias
		}
		out = append(out, FleetMember{
			RustDeskID: p.ID,
			Hostname:   hostname,
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

// Rename sets a platform-side display alias for a machine the caller owns.
// group is the caller's tenant scope (empty for admin). alias "" clears it.
func (s *FleetService) Rename(ctx context.Context, group, rustdeskID, alias string) error {
	if _, err := s.findOwned(ctx, group, rustdeskID); err != nil {
		return err
	}
	return s.store.SetDeviceAlias(ctx, rustdeskID, strings.TrimSpace(alias))
}

// Delete removes a machine the caller owns from their dashboard (hide) and
// best-effort removes it from the RustDesk server too. group is the caller's
// tenant scope (empty for admin).
func (s *FleetService) Delete(ctx context.Context, group, rustdeskID string) error {
	peer, err := s.findOwned(ctx, group, rustdeskID)
	if err != nil {
		return err
	}
	// Best-effort remove from RustDesk (by GUID when known, else the id). A
	// failure here is non-fatal: the local hide still takes it off the dashboard.
	target := peer.GUID
	if target == "" {
		target = peer.ID
	}
	if err := s.rd.DeleteDevice(ctx, target); err != nil && !errors.Is(err, rustdesk.ErrNotConfigured) {
		s.log.Warn("rustdesk delete failed; hiding locally", "id", rustdeskID, "err", err)
	}
	return s.store.SetDeviceHidden(ctx, rustdeskID, true)
}

// findOwned verifies the caller may manage rustdeskID under their scope and
// returns the matching peer. Prevents a technician from renaming/deleting
// another tenant's machine.
func (s *FleetService) findOwned(ctx context.Context, group, rustdeskID string) (*rustdesk.Peer, error) {
	if strings.TrimSpace(rustdeskID) == "" {
		return nil, ErrInvalid
	}
	peers, err := s.rd.ListPeers(ctx, group) // already scoped to the caller's group
	if err != nil {
		if errors.Is(err, rustdesk.ErrNotConfigured) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	for i := range peers {
		if peers[i].ID == rustdeskID {
			return &peers[i], nil
		}
	}
	return nil, ErrNotFound
}

// Enabled reports whether the RustDesk fleet integration is live.
func (s *FleetService) Enabled() bool { return s.rd != nil && s.rd.Configured() }

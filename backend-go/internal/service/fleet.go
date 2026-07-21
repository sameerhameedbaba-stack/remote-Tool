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
// lets them rename or delete a machine.
//
// Tenant isolation is enforced by the PLATFORM, not RustDesk: RustDesk's native
// device-to-group assignment is unreliable, so the admin assigns each machine to
// a technician here (owner_username) and the fleet view filters on that (falling
// back to a matching RustDesk group if one is set). The platform admin sees
// everything.
type FleetService struct {
	rd    *rustdesk.Client
	store *store.Store
	log   *slog.Logger
}

// FleetMember is one machine shown in a panel.
type FleetMember struct {
	RustDeskID string `json:"rustdesk_id"`
	Hostname   string `json:"hostname"`
	Username   string `json:"username"`
	OS         string `json:"os"`
	Online     bool   `json:"online"`
	LastSeen   string `json:"last_seen,omitempty"`
	Owner      string `json:"owner,omitempty"` // assigned technician username
}

// visibleTo reports whether a peer is visible to a caller scoped to `group`
// (a technician username, or "" for the platform admin). Admin sees all
// non-hidden machines; a technician sees machines assigned to them (platform
// owner) or whose RustDesk group matches their username.
func visibleTo(group string, p rustdesk.Peer, ov store.DeviceOverride) bool {
	if ov.Hidden {
		return false
	}
	if group == "" {
		return true // admin
	}
	return strings.EqualFold(ov.Owner, group) || strings.EqualFold(p.Group, group)
}

// ListForTechnician returns the fleet visible to a technician (username), or the
// whole fleet for the admin (group == ""). Applies aliases + owner and hides
// deleted machines. Returns [] (not an error) when RustDesk is unconfigured.
func (s *FleetService) ListForTechnician(ctx context.Context, group string) ([]FleetMember, error) {
	peers, overrides, err := s.snapshot(ctx)
	if err != nil {
		if errors.Is(err, rustdesk.ErrNotConfigured) {
			return []FleetMember{}, nil
		}
		return nil, err
	}

	out := make([]FleetMember, 0, len(peers))
	for _, p := range peers {
		ov := overrides[p.ID]
		if !visibleTo(group, p, ov) {
			continue
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
			Owner:      ov.Owner,
		})
	}
	// Online first, then by hostname.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Online != out[j].Online {
			return out[i].Online
		}
		return out[i].Hostname < out[j].Hostname
	})
	return out, nil
}

// snapshot fetches all peers plus the platform overrides.
func (s *FleetService) snapshot(ctx context.Context) ([]rustdesk.Peer, map[string]store.DeviceOverride, error) {
	peers, err := s.rd.ListPeers(ctx, "") // all; visibility filtered per caller below
	if err != nil {
		return nil, nil, err
	}
	overrides, err := s.store.ListDeviceOverrides(ctx)
	if err != nil {
		s.log.Warn("load device overrides failed", "err", err)
		overrides = map[string]store.DeviceOverride{}
	}
	return peers, overrides, nil
}

// Rename sets a platform-side display alias for a machine the caller owns.
func (s *FleetService) Rename(ctx context.Context, group, rustdeskID, alias string) error {
	if _, err := s.findVisible(ctx, group, rustdeskID); err != nil {
		return err
	}
	return s.store.SetDeviceAlias(ctx, rustdeskID, strings.TrimSpace(alias))
}

// Delete removes a machine the caller owns from their dashboard (hide) and
// best-effort removes it from the RustDesk server too.
func (s *FleetService) Delete(ctx context.Context, group, rustdeskID string) error {
	peer, err := s.findVisible(ctx, group, rustdeskID)
	if err != nil {
		return err
	}
	target := peer.GUID
	if target == "" {
		target = peer.ID
	}
	if err := s.rd.DeleteDevice(ctx, target); err != nil && !errors.Is(err, rustdesk.ErrNotConfigured) {
		s.log.Warn("rustdesk delete failed; hiding locally", "id", rustdeskID, "err", err)
	}
	return s.store.SetDeviceHidden(ctx, rustdeskID, true)
}

// Assign sets which technician owns a machine. Admin-only (enforced by the
// handler). owner "" unassigns.
func (s *FleetService) Assign(ctx context.Context, rustdeskID, owner string) error {
	if strings.TrimSpace(rustdeskID) == "" {
		return ErrInvalid
	}
	return s.store.SetDeviceOwner(ctx, rustdeskID, strings.TrimSpace(owner))
}

// findVisible verifies rustdeskID is visible to the caller's scope and returns
// the matching peer. Prevents a technician from touching another tenant's
// machine.
func (s *FleetService) findVisible(ctx context.Context, group, rustdeskID string) (*rustdesk.Peer, error) {
	if strings.TrimSpace(rustdeskID) == "" {
		return nil, ErrInvalid
	}
	peers, overrides, err := s.snapshot(ctx)
	if err != nil {
		if errors.Is(err, rustdesk.ErrNotConfigured) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	for i := range peers {
		if peers[i].ID == rustdeskID && visibleTo(group, peers[i], overrides[peers[i].ID]) {
			return &peers[i], nil
		}
	}
	return nil, ErrNotFound
}

// Enabled reports whether the RustDesk fleet integration is live.
func (s *FleetService) Enabled() bool { return s.rd != nil && s.rd.Configured() }

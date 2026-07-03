package service

import (
	"context"
	"errors"
	"log/slog"

	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

// DeviceService lists and fetches devices with presence-derived status.
type DeviceService struct {
	store *store.Store
	cache *cache.Cache
	log   *slog.Logger
}

// List returns unattended devices with status derived from Redis presence,
// optionally filtered by name query and online/offline status.
func (s *DeviceService) List(ctx context.Context, statusFilter, nameQuery string) ([]model.Device, error) {
	devices, err := s.store.ListDevices(ctx, nameQuery)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(devices))
	for i := range devices {
		ids[i] = devices[i].ID
	}
	presence, err := s.cache.PresenceMap(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]model.Device, 0, len(devices))
	for i := range devices {
		devices[i].Status = statusFor(presence[devices[i].ID])
		if statusFilter != "" && devices[i].Status != statusFilter {
			continue
		}
		out = append(out, devices[i])
	}
	return out, nil
}

// Get returns one device with presence status. Returns ErrNotFound if unknown.
func (s *DeviceService) Get(ctx context.Context, id string) (*model.Device, error) {
	device, err := s.store.GetDevice(ctx, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	online, err := s.cache.IsOnline(ctx, id)
	if err != nil {
		return nil, err
	}
	device.Status = statusFor(online)
	return device, nil
}

func statusFor(online bool) string {
	if online {
		return model.DeviceStatusOnline
	}
	return model.DeviceStatusOffline
}

// Package model holds the shared domain types used across the store, service,
// and httpapi layers. These types are pure data with JSON tags matching the
// wire contract in docs/API.md.
package model

import "time"

// Roles and enum-like string constants used across the domain.
const (
	RoleAdmin      = "admin"
	RoleTechnician = "technician"

	DeviceModeUnattended = "unattended"
	DeviceModeAttended   = "attended"

	SessionTypeUnattended = "unattended"
	SessionTypeAttended   = "attended"

	SessionStatusPending = "pending"
	SessionStatusActive  = "active"
	SessionStatusEnded   = "ended"

	DeviceStatusOnline  = "online"
	DeviceStatusOffline = "offline"
)

// Technician is a console operator principal and, in the multi-tenant platform,
// a tenant: `Username` maps to their subdomain (username.<domain>). Role `admin`
// is the platform super-admin who creates technicians (`CreatedBy`).
type Technician struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	DisplayName  string    `json:"display_name"`
	Role         string    `json:"role"`
	Active       bool      `json:"active"`
	CreatedBy    *string   `json:"created_by,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// Device is an enrolled endpoint (unattended) or an ephemeral attended peer.
type Device struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	Hostname         string     `json:"hostname"`
	OS               string     `json:"os"`
	DeviceSecretHash string     `json:"-"`
	Mode             string     `json:"mode"`
	AppVersion       string     `json:"app_version"`
	LastSeenAt       *time.Time `json:"last_seen_at"`
	CreatedAt        time.Time  `json:"created_at"`

	// Status is derived from Redis presence at read time; not stored in Postgres.
	Status string `json:"status,omitempty"`
}

// Session is a support session lifecycle record. DeviceID is a pointer because
// an attended session exists (from POST /attended/codes) before the ephemeral
// device is created and bound at POST /attended/join.
type Session struct {
	ID            string     `json:"id"`
	DeviceID      *string    `json:"device_id"`
	TechnicianID  *string    `json:"technician_id"`
	Type          string     `json:"type"`
	Status        string     `json:"status"`
	BannerVisible bool       `json:"banner_visible"`
	StartedAt     *time.Time `json:"started_at"`
	EndedAt       *time.Time `json:"ended_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// AuditEvent is an append-only record of a lifecycle or sensitive-data action.
type AuditEvent struct {
	ID           string         `json:"id"`
	EventType    string         `json:"event_type"`
	SessionID    *string        `json:"session_id"`
	TechnicianID *string        `json:"technician_id"`
	DeviceID     *string        `json:"device_id"`
	Metadata     map[string]any `json:"metadata"`
	CreatedAt    time.Time      `json:"created_at"`
}

// ICEServer is a single entry in the ice_servers list handed to peers.
type ICEServer struct {
	URLs       string `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

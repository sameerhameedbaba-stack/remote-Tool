package httpapi

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/remote-support/backend/internal/model"
	"github.com/remote-support/backend/internal/store"
)

type auditResponse struct {
	Events     []model.AuditEvent `json:"events"`
	NextCursor *string            `json:"next_cursor"`
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// Reject malformed UUID filters before the store casts them to ::uuid (which
	// would raise Postgres 22P02 and surface as a 500).
	if !validOptionalUUID(w, q.Get("session_id"), "session_id") ||
		!validOptionalUUID(w, q.Get("device_id"), "device_id") ||
		!validOptionalUUID(w, q.Get("technician_id"), "technician_id") {
		return
	}

	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 200 {
		limit = 200
	}

	f := store.AuditFilter{
		SessionID:    q.Get("session_id"),
		DeviceID:     q.Get("device_id"),
		TechnicianID: q.Get("technician_id"),
		EventType:    q.Get("event_type"),
		Limit:        limit + 1, // fetch one extra to detect a next page
	}
	if t, ok := parseTime(q.Get("since")); ok {
		f.Since = &t
	}
	if t, ok := parseTime(q.Get("until")); ok {
		f.Until = &t
	}
	if cur := q.Get("cursor"); cur != "" {
		ct, cid, ok := decodeCursor(cur)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", "invalid cursor")
			return
		}
		f.CursorCreatedAt = &ct
		f.CursorID = cid
	}

	events, err := s.audit.List(r.Context(), f)
	if err != nil {
		writeServiceError(w, s.log, err)
		return
	}

	var next *string
	if len(events) > limit {
		last := events[limit-1]
		events = events[:limit]
		c := encodeCursor(last.CreatedAt, last.ID)
		next = &c
	}
	if events == nil {
		events = []model.AuditEvent{}
	}
	writeJSON(w, http.StatusOK, auditResponse{Events: events, NextCursor: next})
}

func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// encodeCursor packs (created_at, id) into an opaque base64 keyset cursor.
func encodeCursor(created time.Time, id string) string {
	raw := created.UTC().Format(time.RFC3339Nano) + "|" + id
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(cur string) (time.Time, string, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(cur)
	if err != nil {
		return time.Time{}, "", false
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, "", false
	}
	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, "", false
	}
	// The id half must be a UUID: it is cast to ::uuid in the keyset predicate,
	// so a malformed value would raise 22P02 instead of the intended 400.
	if _, err := uuid.Parse(parts[1]); err != nil {
		return time.Time{}, "", false
	}
	return t, parts[1], true
}

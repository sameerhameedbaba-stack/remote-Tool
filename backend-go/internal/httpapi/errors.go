package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"github.com/remote-support/backend/internal/service"
)

// parseUUIDParam validates a required UUID value (path param or body id),
// writing a 400 invalid_request and returning false when it is empty or
// malformed. This keeps a bad id from reaching the store's ::uuid cast, which
// would raise Postgres 22P02 and surface as a 500.
func parseUUIDParam(w http.ResponseWriter, value, field string) bool {
	if _, err := uuid.Parse(value); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid "+field)
		return false
	}
	return true
}

// validOptionalUUID validates an optional UUID filter: an empty value is
// allowed (filter absent); a non-empty malformed value writes a 400 and returns
// false.
func validOptionalUUID(w http.ResponseWriter, value, field string) bool {
	if value == "" {
		return true
	}
	return parseUUIDParam(w, value, field)
}

// errorEnvelope is the exact non-2xx body shape from docs/API.md.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeJSON writes v as JSON with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

// writeError writes the standard error envelope.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorEnvelope{Error: errorBody{Code: code, Message: message}})
}

// writeServiceError maps a domain error to the correct status + envelope code.
func writeServiceError(w http.ResponseWriter, log *slog.Logger, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, service.ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication failed")
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "not permitted")
	case errors.Is(err, service.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "conflicting state")
	case errors.Is(err, service.ErrExpired):
		writeError(w, http.StatusGone, "expired", "resource expired")
	case errors.Is(err, service.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many requests")
	case errors.Is(err, service.ErrInvalid):
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid request")
	default:
		log.Error("internal error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal server error")
	}
}

// decodeJSON reads a JSON request body into dst, returning false (and writing an
// error) on failure.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return false
	}
	return true
}

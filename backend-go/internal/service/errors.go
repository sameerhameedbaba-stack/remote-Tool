package service

import "errors"

// Domain errors. The httpapi layer maps these to the error envelope codes in
// docs/API.md.
var (
	ErrNotFound     = errors.New("not_found")
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
	ErrConflict     = errors.New("conflict")
	ErrExpired      = errors.New("expired")
	ErrInvalid      = errors.New("invalid_request")
	ErrRateLimited  = errors.New("rate_limited")
)

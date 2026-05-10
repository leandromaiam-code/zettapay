package zettapay

import (
	"errors"
	"fmt"
)

// Error is the typed error returned by every client method on a non-2xx
// response or transport failure. It mirrors the JSON envelope emitted by the
// API: {"error":{"code","message","details"}}.
//
// Callers can inspect Code / StatusCode for control flow, and use errors.As
// to unwrap into *Error.
type Error struct {
	// Code is the API error code (e.g. "not_found", "validation_error",
	// "rate_limited"). For transport failures (DNS, dial, timeout) Code is
	// "network_error" or "timeout". StatusCode is 0 in that case.
	Code string
	// Message is a human-readable explanation, taken from the API body when
	// available, otherwise from the underlying transport error.
	Message string
	// StatusCode is the HTTP status code, or 0 for transport failures.
	StatusCode int
	// Details is an optional structured payload returned by the API
	// (typically a list of validation problems).
	Details any
	// Cause is the wrapped underlying error, if any.
	Cause error
}

func (e *Error) Error() string {
	if e.StatusCode > 0 {
		return fmt.Sprintf("zettapay: %s (code=%s, status=%d)", e.Message, e.Code, e.StatusCode)
	}
	return fmt.Sprintf("zettapay: %s (code=%s)", e.Message, e.Code)
}

func (e *Error) Unwrap() error { return e.Cause }

// IsCode reports whether err is a *Error with the given code.
func IsCode(err error, code string) bool {
	var zerr *Error
	if errors.As(err, &zerr) {
		return zerr.Code == code
	}
	return false
}

// IsStatus reports whether err is a *Error with the given HTTP status.
func IsStatus(err error, status int) bool {
	var zerr *Error
	if errors.As(err, &zerr) {
		return zerr.StatusCode == status
	}
	return false
}

// retryable reports whether the error is safe to retry. Network errors
// (StatusCode == 0) and 5xx / 429 responses are retryable.
func (e *Error) retryable() bool {
	if e.StatusCode == 0 {
		return true
	}
	if e.StatusCode == 429 {
		return true
	}
	return e.StatusCode >= 500 && e.StatusCode <= 599
}

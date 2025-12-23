package durablestreams

import (
	"errors"
	"fmt"
)

// Sentinel errors for common conditions.
var (
	// Done is returned by iterators when iteration is complete.
	// Check with errors.Is(err, durablestreams.Done).
	Done = errors.New("durablestreams: no more items in iterator")

	// ErrStreamNotFound indicates the stream does not exist (404).
	ErrStreamNotFound = errors.New("durablestreams: stream not found")

	// ErrStreamExists indicates a create conflict with different config (409).
	ErrStreamExists = errors.New("durablestreams: stream already exists with different config")

	// ErrSeqConflict indicates a sequence ordering violation (409).
	ErrSeqConflict = errors.New("durablestreams: sequence conflict")

	// ErrOffsetGone indicates the offset is before retained data (410).
	ErrOffsetGone = errors.New("durablestreams: offset before retention window")

	// ErrRateLimited indicates rate limiting (429).
	ErrRateLimited = errors.New("durablestreams: rate limited")

	// ErrContentTypeMismatch indicates append content type doesn't match stream (409).
	ErrContentTypeMismatch = errors.New("durablestreams: content type mismatch")

	// ErrEmptyAppend indicates an attempt to append empty data.
	ErrEmptyAppend = errors.New("durablestreams: cannot append empty data")

	// ErrAlreadyClosed indicates the iterator has already been closed.
	ErrAlreadyClosed = errors.New("durablestreams: iterator already closed")
)

// StreamError wraps errors with additional context about the failed operation.
type StreamError struct {
	// Op is the operation that failed: "create", "append", "read", "delete", "head".
	Op string

	// URL is the stream URL.
	URL string

	// StatusCode is the HTTP status code, if available.
	StatusCode int

	// Err is the underlying error.
	Err error
}

// Error implements the error interface.
func (e *StreamError) Error() string {
	if e.StatusCode > 0 {
		return fmt.Sprintf("durablestreams: %s %s failed with status %d: %v", e.Op, e.URL, e.StatusCode, e.Err)
	}
	return fmt.Sprintf("durablestreams: %s %s failed: %v", e.Op, e.URL, e.Err)
}

// Unwrap returns the underlying error for errors.Is/As support.
func (e *StreamError) Unwrap() error {
	return e.Err
}

// newStreamError creates a StreamError from an HTTP response.
func newStreamError(op, url string, statusCode int, err error) *StreamError {
	return &StreamError{
		Op:         op,
		URL:        url,
		StatusCode: statusCode,
		Err:        err,
	}
}

// errorFromStatus maps HTTP status codes to appropriate sentinel errors.
func errorFromStatus(statusCode int) error {
	switch statusCode {
	case 404:
		return ErrStreamNotFound
	case 409:
		return ErrStreamExists // Could also be ErrSeqConflict or ErrContentTypeMismatch depending on context
	case 410:
		return ErrOffsetGone
	case 429:
		return ErrRateLimited
	default:
		return fmt.Errorf("unexpected status code: %d", statusCode)
	}
}

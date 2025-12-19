package store

import (
	"context"
	"errors"
	"time"
)

// Common errors
var (
	ErrStreamNotFound      = errors.New("stream not found")
	ErrStreamExpired       = errors.New("stream has expired")
	ErrStreamExists        = errors.New("stream already exists")
	ErrConfigMismatch      = errors.New("stream configuration mismatch")
	ErrSequenceConflict    = errors.New("sequence number conflict")
	ErrContentTypeMismatch = errors.New("content type mismatch")
	ErrEmptyBody           = errors.New("empty body not allowed")
	ErrInvalidOffset       = errors.New("invalid offset")
	ErrEmptyJSONArray      = errors.New("empty JSON array not allowed")
	ErrInvalidJSON         = errors.New("invalid JSON")
)

// Store is the interface for durable stream storage
type Store interface {
	// Create creates a new stream. Returns ErrStreamExists if stream exists with
	// different config, or nil if stream exists with same config (idempotent).
	// The bool return value indicates if the stream was newly created (true) or
	// already existed with matching config (false).
	Create(path string, opts CreateOptions) (*StreamMetadata, bool, error)

	// Get returns metadata for a stream, or ErrStreamNotFound if not found
	Get(path string) (*StreamMetadata, error)

	// Has returns true if the stream exists
	Has(path string) bool

	// Delete removes a stream. Returns ErrStreamNotFound if not found.
	Delete(path string) error

	// Append adds data to a stream. Returns the new offset after append.
	// Returns ErrStreamNotFound if stream doesn't exist.
	// Returns ErrSequenceConflict if seq is provided and <= last seq.
	// Returns ErrContentTypeMismatch if content type doesn't match.
	Append(path string, data []byte, opts AppendOptions) (Offset, error)

	// Read reads messages from a stream starting at the given offset.
	// Returns messages, whether we're up to date (at tail), and any error.
	// Returns ErrStreamNotFound if stream doesn't exist.
	Read(path string, offset Offset) ([]Message, bool, error)

	// WaitForMessages waits for new messages after the given offset.
	// Returns when messages are available, timeout expires, or context is cancelled.
	// If messages exist at the offset, returns immediately.
	// timedOut is true if we returned due to timeout with no messages.
	WaitForMessages(ctx context.Context, path string, offset Offset, timeout time.Duration) (messages []Message, timedOut bool, err error)

	// GetCurrentOffset returns the current tail offset for a stream
	GetCurrentOffset(path string) (Offset, error)

	// Close releases any resources held by the store
	Close() error
}

// CreateOptions contains options for creating a stream
type CreateOptions struct {
	ContentType string
	TTLSeconds  *int64
	ExpiresAt   *time.Time
	InitialData []byte
}

// AppendOptions contains options for appending to a stream
type AppendOptions struct {
	Seq         string // Stream-Seq header value for coordination
	ContentType string // Content-Type to validate against stream
}

// Message represents a single message in a stream
type Message struct {
	Data   []byte
	Offset Offset
}

// StreamMetadata contains metadata about a stream
type StreamMetadata struct {
	Path          string
	ContentType   string
	CurrentOffset Offset
	LastSeq       string // Last Stream-Seq value
	TTLSeconds    *int64
	ExpiresAt     *time.Time
	CreatedAt     time.Time
}

// IsExpired checks if the stream has expired based on TTL or ExpiresAt
func (m *StreamMetadata) IsExpired() bool {
	now := time.Now()

	// Check explicit expiry time
	if m.ExpiresAt != nil && now.After(*m.ExpiresAt) {
		return true
	}

	// Check TTL-based expiry
	if m.TTLSeconds != nil {
		expiryTime := m.CreatedAt.Add(time.Duration(*m.TTLSeconds) * time.Second)
		if now.After(expiryTime) {
			return true
		}
	}

	return false
}

// ConfigMatches checks if another set of options matches this stream's config
func (m *StreamMetadata) ConfigMatches(opts CreateOptions) bool {
	// Content type must match (case-insensitive for the type/subtype)
	if !ContentTypeMatches(m.ContentType, opts.ContentType) {
		return false
	}

	// TTL must match
	if (m.TTLSeconds == nil) != (opts.TTLSeconds == nil) {
		return false
	}
	if m.TTLSeconds != nil && opts.TTLSeconds != nil && *m.TTLSeconds != *opts.TTLSeconds {
		return false
	}

	// ExpiresAt must match
	if (m.ExpiresAt == nil) != (opts.ExpiresAt == nil) {
		return false
	}
	if m.ExpiresAt != nil && opts.ExpiresAt != nil && !m.ExpiresAt.Equal(*opts.ExpiresAt) {
		return false
	}

	return true
}

// ContentTypeMatches compares two content types, ignoring case and parameters
func ContentTypeMatches(a, b string) bool {
	// Normalize empty to default
	if a == "" {
		a = "application/octet-stream"
	}
	if b == "" {
		b = "application/octet-stream"
	}

	// Extract base type (before semicolon)
	aBase := extractMediaType(a)
	bBase := extractMediaType(b)

	// Case-insensitive comparison
	return equalFold(aBase, bBase)
}

// extractMediaType extracts the media type from a content-type header
// (removes parameters like charset)
func extractMediaType(ct string) string {
	for i := 0; i < len(ct); i++ {
		if ct[i] == ';' {
			return ct[:i]
		}
	}
	return ct
}

// equalFold is a simple ASCII case-insensitive string comparison
func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

// ExtractMediaType is the exported version of extractMediaType
func ExtractMediaType(ct string) string {
	return extractMediaType(ct)
}

// IsJSONContentType returns true if the content type is application/json
func IsJSONContentType(ct string) bool {
	mediaType := toLower(extractMediaType(ct))
	return mediaType == "application/json"
}

// FormatJSONResponse formats messages as a JSON array
func FormatJSONResponse(messages []Message) []byte {
	if len(messages) == 0 {
		return []byte("[]")
	}

	// Calculate total size
	total := 2 // for [ and ]
	for i, msg := range messages {
		if i > 0 {
			total++ // comma
		}
		total += len(msg.Data)
	}

	result := make([]byte, 0, total)
	result = append(result, '[')
	for i, msg := range messages {
		if i > 0 {
			result = append(result, ',')
		}
		result = append(result, msg.Data...)
	}
	result = append(result, ']')
	return result
}

// toLower converts ASCII string to lowercase
func toLower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}

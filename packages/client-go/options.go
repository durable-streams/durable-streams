package durablestreams

import (
	"net/http"
	"time"
)

// LiveMode specifies how the client handles live streaming.
type LiveMode string

const (
	// LiveModeNone stops after catching up (no live tailing).
	// This is the default mode.
	LiveModeNone LiveMode = ""

	// LiveModeLongPoll uses HTTP long-polling for live updates.
	// The server holds the connection open until new data arrives or timeout.
	LiveModeLongPoll LiveMode = "long-poll"

	// LiveModeSSE uses Server-Sent Events for live updates.
	// Only valid for text/* and application/json content types.
	LiveModeSSE LiveMode = "sse"

	// LiveModeAuto selects the best mode based on content type.
	// Uses SSE for text/* and application/json, long-poll otherwise.
	LiveModeAuto LiveMode = "auto"
)

// =============================================================================
// Client Options
// =============================================================================

type clientConfig struct {
	httpClient  *http.Client
	baseURL     string
	retryPolicy *RetryPolicy
}

// ClientOption configures a Client.
type ClientOption func(*clientConfig)

// WithHTTPClient sets a custom HTTP client.
// If not set, a default client with sensible timeouts is used.
func WithHTTPClient(c *http.Client) ClientOption {
	return func(cfg *clientConfig) {
		cfg.httpClient = c
	}
}

// WithBaseURL sets a base URL that will be prepended to stream paths.
// This is optional; you can also use full URLs when calling Client.Stream().
func WithBaseURL(url string) ClientOption {
	return func(cfg *clientConfig) {
		cfg.baseURL = url
	}
}

// WithRetryPolicy sets the retry policy for transient errors.
func WithRetryPolicy(p RetryPolicy) ClientOption {
	return func(cfg *clientConfig) {
		cfg.retryPolicy = &p
	}
}

// RetryPolicy configures retry behavior for transient errors.
type RetryPolicy struct {
	// MaxRetries is the maximum number of retry attempts.
	// Default is 3.
	MaxRetries int

	// InitialDelay is the delay before the first retry.
	// Default is 100ms.
	InitialDelay time.Duration

	// MaxDelay is the maximum delay between retries.
	// Default is 30s.
	MaxDelay time.Duration

	// Multiplier is the exponential backoff multiplier.
	// Default is 2.0.
	Multiplier float64
}

// DefaultRetryPolicy returns the default retry policy.
func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		MaxRetries:   3,
		InitialDelay: 100 * time.Millisecond,
		MaxDelay:     30 * time.Second,
		Multiplier:   2.0,
	}
}

// =============================================================================
// Create Options
// =============================================================================

type createConfig struct {
	contentType string
	ttl         time.Duration
	expiresAt   time.Time
	initialData []byte
	headers     map[string]string
}

// CreateOption configures a Create operation.
type CreateOption func(*createConfig)

// WithContentType sets the stream's content type.
// Default is "application/octet-stream".
func WithContentType(ct string) CreateOption {
	return func(cfg *createConfig) {
		cfg.contentType = ct
	}
}

// WithTTL sets the stream's time-to-live.
// Mutually exclusive with WithExpiresAt.
func WithTTL(d time.Duration) CreateOption {
	return func(cfg *createConfig) {
		cfg.ttl = d
	}
}

// WithExpiresAt sets the stream's absolute expiry time.
// Mutually exclusive with WithTTL.
func WithExpiresAt(t time.Time) CreateOption {
	return func(cfg *createConfig) {
		cfg.expiresAt = t
	}
}

// WithInitialData sets initial data to write when creating the stream.
func WithInitialData(data []byte) CreateOption {
	return func(cfg *createConfig) {
		cfg.initialData = data
	}
}

// WithCreateHeaders sets custom headers for the create request.
func WithCreateHeaders(headers map[string]string) CreateOption {
	return func(cfg *createConfig) {
		cfg.headers = headers
	}
}

// =============================================================================
// Append Options
// =============================================================================

type appendConfig struct {
	seq     string
	ifMatch string
	headers map[string]string
}

// AppendOption configures an Append operation.
type AppendOption func(*appendConfig)

// WithSeq sets the sequence number for writer coordination.
// Sequence numbers must be strictly increasing (lexicographically).
// If a lower sequence is sent, the server returns 409 Conflict.
func WithSeq(seq string) AppendOption {
	return func(cfg *appendConfig) {
		cfg.seq = seq
	}
}

// WithIfMatch sets an ETag for optimistic concurrency control.
// The append will fail with 412 Precondition Failed if the ETag doesn't match.
func WithIfMatch(etag string) AppendOption {
	return func(cfg *appendConfig) {
		cfg.ifMatch = etag
	}
}

// WithAppendHeaders sets custom headers for the append request.
func WithAppendHeaders(headers map[string]string) AppendOption {
	return func(cfg *appendConfig) {
		cfg.headers = headers
	}
}

// =============================================================================
// Read Options
// =============================================================================

type readConfig struct {
	offset   Offset
	live     LiveMode
	cursor   string
	headers  map[string]string
	timeout  time.Duration
}

// ReadOption configures a Read operation.
type ReadOption func(*readConfig)

// WithOffset sets the starting offset for reading.
// Default is StartOffset ("-1") which reads from the beginning.
func WithOffset(o Offset) ReadOption {
	return func(cfg *readConfig) {
		cfg.offset = o
	}
}

// WithLive sets the live streaming mode.
// Default is LiveModeNone (catch-up only, no live tailing).
func WithLive(mode LiveMode) ReadOption {
	return func(cfg *readConfig) {
		cfg.live = mode
	}
}

// WithCursor sets the cursor for CDN request collapsing.
// This is typically handled automatically by the iterator.
// Only use for advanced scenarios like resuming from a saved cursor.
func WithCursor(cursor string) ReadOption {
	return func(cfg *readConfig) {
		cfg.cursor = cursor
	}
}

// WithReadHeaders sets custom headers for read requests.
func WithReadHeaders(headers map[string]string) ReadOption {
	return func(cfg *readConfig) {
		cfg.headers = headers
	}
}

// WithReadTimeout sets the timeout for read operations.
// For long-poll mode, this is the maximum time to wait for new data.
func WithReadTimeout(d time.Duration) ReadOption {
	return func(cfg *readConfig) {
		cfg.timeout = d
	}
}

// =============================================================================
// Head Options
// =============================================================================

type headConfig struct {
	headers map[string]string
}

// HeadOption configures a Head operation.
type HeadOption func(*headConfig)

// WithHeadHeaders sets custom headers for the head request.
func WithHeadHeaders(headers map[string]string) HeadOption {
	return func(cfg *headConfig) {
		cfg.headers = headers
	}
}

// =============================================================================
// Delete Options
// =============================================================================

type deleteConfig struct {
	headers map[string]string
}

// DeleteOption configures a Delete operation.
type DeleteOption func(*deleteConfig)

// WithDeleteHeaders sets custom headers for the delete request.
func WithDeleteHeaders(headers map[string]string) DeleteOption {
	return func(cfg *deleteConfig) {
		cfg.headers = headers
	}
}

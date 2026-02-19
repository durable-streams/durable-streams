package webhook

import (
	"sync"
	"time"
)

// ConsumerState represents the state machine for a consumer instance.
type ConsumerState string

const (
	StateIDLE   ConsumerState = "IDLE"
	StateWAKING ConsumerState = "WAKING"
	StateLIVE   ConsumerState = "LIVE"
)

// Subscription represents a webhook subscription.
type Subscription struct {
	SubscriptionID string `json:"subscription_id"`
	Pattern        string `json:"pattern"`
	Webhook        string `json:"webhook"`
	WebhookSecret  string `json:"webhook_secret,omitempty"`
	Description    string `json:"description,omitempty"`
}

// ConsumerInstance tracks the state of a single consumer (subscription + stream pair).
type ConsumerInstance struct {
	mu sync.Mutex

	ConsumerID     string
	SubscriptionID string
	PrimaryStream  string
	State          ConsumerState
	Epoch          int
	WakeID         string
	WakeIDClaimed  bool
	Streams        map[string]string // path -> last acked offset
	LastCallbackAt time.Time

	LastWebhookFailureAt  *time.Time
	FirstWebhookFailureAt *time.Time
	RetryCount            int

	// Timer cancellation channels — close to cancel the goroutine
	retryCancel   chan struct{}
	livenessCancel chan struct{}
}

// CancelRetry cancels any pending retry timer.
func (c *ConsumerInstance) CancelRetry() {
	if c.retryCancel != nil {
		close(c.retryCancel)
		c.retryCancel = nil
	}
}

// CancelLiveness cancels any pending liveness timer.
func (c *ConsumerInstance) CancelLiveness() {
	if c.livenessCancel != nil {
		close(c.livenessCancel)
		c.livenessCancel = nil
	}
}

// CallbackRequest is the JSON body sent by consumers to the callback endpoint.
type CallbackRequest struct {
	Epoch       int        `json:"epoch"`
	WakeID      string     `json:"wake_id,omitempty"`
	Acks        []AckEntry `json:"acks,omitempty"`
	Subscribe   []string   `json:"subscribe,omitempty"`
	Unsubscribe []string   `json:"unsubscribe,omitempty"`
	Done        *bool      `json:"done,omitempty"`
}

// AckEntry represents an offset acknowledgment for a stream.
type AckEntry struct {
	Path   string `json:"path"`
	Offset string `json:"offset"`
}

// StreamEntry represents a stream and its current offset.
type StreamEntry struct {
	Path   string `json:"path"`
	Offset string `json:"offset"`
}

// CallbackSuccess is returned on a successful callback.
type CallbackSuccess struct {
	OK      bool          `json:"ok"`
	Token   string        `json:"token"`
	Streams []StreamEntry `json:"streams"`
}

// CallbackErrorResponse is returned on a failed callback.
type CallbackErrorResponse struct {
	OK    bool           `json:"ok"`
	Error CallbackErrObj `json:"error"`
	Token string         `json:"token,omitempty"`
}

// CallbackErrObj holds the error code and message.
type CallbackErrObj struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error code constants.
const (
	ErrCodeInvalidRequest = "INVALID_REQUEST"
	ErrCodeTokenExpired   = "TOKEN_EXPIRED"
	ErrCodeTokenInvalid   = "TOKEN_INVALID"
	ErrCodeAlreadyClaimed = "ALREADY_CLAIMED"
	ErrCodeInvalidOffset  = "INVALID_OFFSET"
	ErrCodeStaleEpoch     = "STALE_EPOCH"
	ErrCodeConsumerGone   = "CONSUMER_GONE"
)

// ErrorCodeToHTTPStatus maps callback error codes to HTTP status codes.
var ErrorCodeToHTTPStatus = map[string]int{
	ErrCodeInvalidRequest: 400,
	ErrCodeTokenExpired:   401,
	ErrCodeTokenInvalid:   401,
	ErrCodeAlreadyClaimed: 409,
	ErrCodeInvalidOffset:  409,
	ErrCodeStaleEpoch:     409,
	ErrCodeConsumerGone:   410,
}

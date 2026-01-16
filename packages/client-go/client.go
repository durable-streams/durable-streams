package durablestreams

import (
	"net"
	"net/http"
	"strings"
	"time"
)

// Client is a durable streams client.
// It is safe for concurrent use.
//
// The client uses an optimized HTTP transport with:
//   - Connection pooling (100 idle connections, 10 per host)
//   - HTTP/2 support (automatic for HTTPS)
//   - Reasonable timeouts for dial, TLS handshake, and idle connections
//   - Keep-alive for connection reuse
type Client struct {
	httpClient  *http.Client
	baseURL     string
	retryPolicy RetryPolicy
}

// NewClient creates a new durable streams client.
//
// Example:
//
//	client := durablestreams.NewClient()
//	stream := client.Stream("https://example.com/streams/my-stream")
func NewClient(opts ...ClientOption) *Client {
	cfg := &clientConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	// Default HTTP client with optimized transport settings
	httpClient := cfg.httpClient
	if httpClient == nil {
		transport := &http.Transport{
			// Connection pooling
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 10,
			MaxConnsPerHost:     0, // No limit
			IdleConnTimeout:     90 * time.Second,

			// Timeouts
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 0, // No timeout (handled at request level)
			ExpectContinueTimeout: 1 * time.Second,

			// Compression
			DisableCompression: false,

			// HTTP/2 is enabled by default for HTTPS when using http.DefaultTransport
			// or when ForceAttemptHTTP2 is true
			ForceAttemptHTTP2: true,
		}

		httpClient = &http.Client{
			Timeout:   0, // No global timeout - use context for per-request timeout
			Transport: transport,
		}
	}

	// Default retry policy
	retryPolicy := DefaultRetryPolicy()
	if cfg.retryPolicy != nil {
		retryPolicy = *cfg.retryPolicy
	}

	return &Client{
		httpClient:  httpClient,
		baseURL:     strings.TrimSuffix(cfg.baseURL, "/"),
		retryPolicy: retryPolicy,
	}
}

// Stream returns a handle to a stream at the given URL.
// No network request is made until an operation is called.
//
// The url can be:
//   - A full URL: "https://example.com/streams/my-stream"
//   - A path (if baseURL was set): "/streams/my-stream"
func (c *Client) Stream(url string) *Stream {
	// If url doesn't start with http and we have a baseURL, prepend it
	fullURL := url
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		if c.baseURL != "" {
			fullURL = c.baseURL + url
		}
	}

	return &Stream{
		url:    fullURL,
		client: c,
	}
}

// HTTPClient returns the underlying HTTP client.
// This can be useful for advanced configuration or testing.
func (c *Client) HTTPClient() *http.Client {
	return c.httpClient
}

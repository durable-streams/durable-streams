package durablestreams

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Protocol header names
const (
	headerContentType    = "Content-Type"
	headerStreamOffset   = "Stream-Next-Offset"
	headerStreamCursor   = "Stream-Cursor"
	headerStreamUpToDate = "Stream-Up-To-Date"
	headerStreamSeq      = "Stream-Seq"
	headerStreamTTL      = "Stream-TTL"
	headerStreamExpires  = "Stream-Expires-At"
	headerETag           = "ETag"
	headerIfMatch        = "If-Match"
)

// Stream represents a durable stream handle.
// It is a lightweight, reusable object - not a persistent connection.
//
// Create a Stream using Client.Stream():
//
//	stream := client.Stream("https://example.com/streams/my-stream")
type Stream struct {
	url    string
	client *Client

	// Cached content type from HEAD/Create operations
	contentType string
}

// URL returns the stream's URL.
func (s *Stream) URL() string {
	return s.url
}

// ContentType returns the cached content type.
// This is populated after Create or Head operations.
func (s *Stream) ContentType() string {
	return s.contentType
}

// SetContentType sets the cached content type.
// Use this when you know the stream's content type without calling Head.
func (s *Stream) SetContentType(ct string) {
	s.contentType = ct
}

// Metadata contains stream information from HEAD request.
type Metadata struct {
	// ContentType is the stream's MIME type.
	ContentType string

	// NextOffset is the tail offset (next position after current end).
	NextOffset Offset

	// TTL is the remaining time-to-live, if set.
	TTL *time.Duration

	// ExpiresAt is the absolute expiry time, if set.
	ExpiresAt *time.Time

	// ETag for conditional requests.
	ETag string
}

// AppendResult contains the response from an append operation.
type AppendResult struct {
	// NextOffset is the tail offset after this append.
	// Use this for checkpointing or exactly-once semantics.
	NextOffset Offset

	// ETag for conditional requests (if returned by server).
	ETag string
}

// Create creates a new stream (idempotent).
// Succeeds if the stream already exists with matching config.
// Returns ErrStreamExists only if config differs (409 Conflict).
//
// Example:
//
//	err := stream.Create(ctx,
//	    durablestreams.WithContentType("application/json"),
//	    durablestreams.WithTTL(24*time.Hour),
//	)
func (s *Stream) Create(ctx context.Context, opts ...CreateOption) error {
	cfg := &createConfig{
		contentType: "application/octet-stream",
	}
	for _, opt := range opts {
		opt(cfg)
	}

	// Build request
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, s.url, nil)
	if err != nil {
		return newStreamError("create", s.url, 0, err)
	}

	// Set headers
	req.Header.Set(headerContentType, cfg.contentType)

	if cfg.ttl > 0 {
		req.Header.Set(headerStreamTTL, strconv.FormatInt(int64(cfg.ttl.Seconds()), 10))
	}
	if !cfg.expiresAt.IsZero() {
		req.Header.Set(headerStreamExpires, cfg.expiresAt.Format(time.RFC3339))
	}

	// Custom headers
	for k, v := range cfg.headers {
		req.Header.Set(k, v)
	}

	// Initial data
	if len(cfg.initialData) > 0 {
		req.Body = io.NopCloser(bytes.NewReader(cfg.initialData))
		req.ContentLength = int64(len(cfg.initialData))
	}

	// Execute request
	resp, err := s.client.httpClient.Do(req)
	if err != nil {
		return newStreamError("create", s.url, 0, err)
	}
	defer resp.Body.Close()

	// Read and discard body
	io.Copy(io.Discard, resp.Body)

	// Handle response
	switch resp.StatusCode {
	case http.StatusCreated, http.StatusOK, http.StatusNoContent:
		// Success - cache content type
		s.contentType = cfg.contentType
		return nil
	case http.StatusConflict:
		return newStreamError("create", s.url, resp.StatusCode, ErrStreamExists)
	default:
		return newStreamError("create", s.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// Append writes data to the stream and returns the result.
// The AppendResult contains the NextOffset for checkpointing.
// Append automatically retries on transient errors (5xx, 429) with exponential backoff.
//
// Example:
//
//	result, err := stream.Append(ctx, []byte(`{"event": "test"}`))
//	fmt.Println("Next offset:", result.NextOffset)
func (s *Stream) Append(ctx context.Context, data []byte, opts ...AppendOption) (*AppendResult, error) {
	if len(data) == 0 {
		return nil, newStreamError("append", s.url, 0, ErrEmptyAppend)
	}

	cfg := &appendConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	// Set content type (use cached or default)
	contentType := s.contentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Create request builder for retry
	makeRequest := func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(data))
		if err != nil {
			return nil, err
		}

		req.Header.Set(headerContentType, contentType)

		// Optional headers
		if cfg.seq != "" {
			req.Header.Set(headerStreamSeq, cfg.seq)
		}
		if cfg.ifMatch != "" {
			req.Header.Set(headerIfMatch, cfg.ifMatch)
		}

		// Custom headers
		for k, v := range cfg.headers {
			req.Header.Set(k, v)
		}

		return req, nil
	}

	// Execute with retry
	resp, err := s.doWithRetry(ctx, makeRequest)
	if err != nil {
		return nil, newStreamError("append", s.url, 0, err)
	}
	defer resp.Body.Close()

	// Read and discard body
	io.Copy(io.Discard, resp.Body)

	// Handle response
	switch resp.StatusCode {
	case http.StatusOK, http.StatusNoContent:
		return &AppendResult{
			NextOffset: Offset(resp.Header.Get(headerStreamOffset)),
			ETag:       resp.Header.Get(headerETag),
		}, nil
	case http.StatusNotFound:
		return nil, newStreamError("append", s.url, resp.StatusCode, ErrStreamNotFound)
	case http.StatusConflict:
		// Could be sequence conflict or content-type mismatch
		return nil, newStreamError("append", s.url, resp.StatusCode, ErrSeqConflict)
	default:
		return nil, newStreamError("append", s.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// AppendJSON writes JSON data to the stream.
// For JSON streams, arrays are flattened one level per protocol spec.
//
// Example:
//
//	result, err := stream.AppendJSON(ctx, map[string]any{"event": "test"})
func (s *Stream) AppendJSON(ctx context.Context, v any, opts ...AppendOption) (*AppendResult, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, newStreamError("append", s.url, 0, fmt.Errorf("json marshal: %w", err))
	}
	return s.Append(ctx, data, opts...)
}

// Delete removes the stream.
//
// Example:
//
//	err := stream.Delete(ctx)
func (s *Stream) Delete(ctx context.Context, opts ...DeleteOption) error {
	cfg := &deleteConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, s.url, nil)
	if err != nil {
		return newStreamError("delete", s.url, 0, err)
	}

	// Custom headers
	for k, v := range cfg.headers {
		req.Header.Set(k, v)
	}

	resp, err := s.client.httpClient.Do(req)
	if err != nil {
		return newStreamError("delete", s.url, 0, err)
	}
	defer resp.Body.Close()

	io.Copy(io.Discard, resp.Body)

	switch resp.StatusCode {
	case http.StatusOK, http.StatusNoContent:
		return nil
	case http.StatusNotFound:
		return newStreamError("delete", s.url, resp.StatusCode, ErrStreamNotFound)
	default:
		return newStreamError("delete", s.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// Head returns stream metadata without reading content.
//
// Example:
//
//	meta, err := stream.Head(ctx)
//	fmt.Println("Content-Type:", meta.ContentType)
//	fmt.Println("Next offset:", meta.NextOffset)
func (s *Stream) Head(ctx context.Context, opts ...HeadOption) (*Metadata, error) {
	cfg := &headConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, s.url, nil)
	if err != nil {
		return nil, newStreamError("head", s.url, 0, err)
	}

	// Custom headers
	for k, v := range cfg.headers {
		req.Header.Set(k, v)
	}

	resp, err := s.client.httpClient.Do(req)
	if err != nil {
		return nil, newStreamError("head", s.url, 0, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		meta := &Metadata{
			ContentType: resp.Header.Get(headerContentType),
			NextOffset:  Offset(resp.Header.Get(headerStreamOffset)),
			ETag:        resp.Header.Get(headerETag),
		}

		// Cache content type
		if meta.ContentType != "" {
			s.contentType = meta.ContentType
		}

		// Parse optional TTL
		if ttlStr := resp.Header.Get(headerStreamTTL); ttlStr != "" {
			if secs, err := strconv.ParseInt(ttlStr, 10, 64); err == nil {
				ttl := time.Duration(secs) * time.Second
				meta.TTL = &ttl
			}
		}

		// Parse optional expiry
		if expiresStr := resp.Header.Get(headerStreamExpires); expiresStr != "" {
			if t, err := time.Parse(time.RFC3339, expiresStr); err == nil {
				meta.ExpiresAt = &t
			}
		}

		return meta, nil
	case http.StatusNotFound:
		return nil, newStreamError("head", s.url, resp.StatusCode, ErrStreamNotFound)
	default:
		return nil, newStreamError("head", s.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// Read returns an iterator for reading stream chunks.
// Each chunk corresponds to one HTTP response body.
// The iterator handles catch-up, live tailing, and cursor propagation automatically.
//
// Always call Close() when done:
//
//	it := stream.Read(ctx)
//	defer it.Close()
//
//	for {
//	    chunk, err := it.Next()
//	    if errors.Is(err, durablestreams.Done) {
//	        break
//	    }
//	    if err != nil {
//	        return err
//	    }
//	    // Process chunk.Data
//	}
func (s *Stream) Read(ctx context.Context, opts ...ReadOption) *ChunkIterator {
	cfg := &readConfig{
		offset:  StartOffset,
		live:    LiveModeNone,
		timeout: 30 * time.Second,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	// Handle LiveModeAuto: select SSE for text/* and application/json, long-poll otherwise
	liveMode := cfg.live
	if liveMode == LiveModeAuto {
		liveMode = s.selectLiveMode()
	}

	// Create a cancellable context for the iterator
	iterCtx, cancel := context.WithCancel(ctx)

	return &ChunkIterator{
		stream:   s,
		ctx:      iterCtx,
		cancel:   cancel,
		offset:   cfg.offset,
		live:     liveMode,
		cursor:   cfg.cursor,
		headers:  cfg.headers,
		timeout:  cfg.timeout,
		Offset:   cfg.offset,
		UpToDate: false,
	}
}

// selectLiveMode chooses the best live mode based on content type.
// Returns SSE for text/* and application/json, long-poll otherwise.
func (s *Stream) selectLiveMode() LiveMode {
	ct := s.contentType
	if ct == "" {
		// No content type cached, use long-poll as safer default
		return LiveModeLongPoll
	}

	// SSE is suitable for text types and JSON
	if strings.HasPrefix(ct, "text/") || strings.HasPrefix(ct, "application/json") {
		return LiveModeSSE
	}

	// For binary and other types, use long-poll
	return LiveModeLongPoll
}

// buildReadURL constructs the URL for a read request with query parameters.
func (s *Stream) buildReadURL(offset Offset, live LiveMode, cursor string) string {
	u, err := url.Parse(s.url)
	if err != nil {
		return s.url
	}

	q := u.Query()

	// Always include offset (even for start position "-1")
	if offset.IsStart() {
		q.Set("offset", string(StartOffset))
	} else {
		q.Set("offset", string(offset))
	}

	// Add live mode
	switch live {
	case LiveModeLongPoll:
		q.Set("live", "long-poll")
	case LiveModeSSE:
		q.Set("live", "sse")
	}

	// Add cursor for CDN collapsing
	if cursor != "" {
		q.Set("cursor", cursor)
	}

	u.RawQuery = q.Encode()
	return u.String()
}

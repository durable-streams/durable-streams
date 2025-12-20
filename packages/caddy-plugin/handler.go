package durablestreams

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/durable-streams/durable-streams/packages/caddy-plugin/store"
	"go.uber.org/zap"
)

// Protocol header names
const (
	HeaderStreamNextOffset = "Stream-Next-Offset"
	HeaderStreamCursor     = "Stream-Cursor"
	HeaderStreamUpToDate   = "Stream-Up-To-Date"
	HeaderStreamSeq        = "Stream-Seq"
	HeaderStreamTTL        = "Stream-TTL"
	HeaderStreamExpiresAt  = "Stream-Expires-At"
)

// ServeHTTP implements caddyhttp.MiddlewareHandler
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	// Set CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Stream-Seq, Stream-TTL, Stream-Expires-At, If-None-Match")
	w.Header().Set("Access-Control-Expose-Headers", "Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, ETag, Location")

	// Handle preflight
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}

	// Extract stream path from URL
	streamPath := r.URL.Path

	h.logger.Debug("handling request",
		zap.String("method", r.Method),
		zap.String("path", streamPath),
		zap.String("query", r.URL.RawQuery))

	var err error
	switch r.Method {
	case http.MethodPut:
		err = h.handleCreate(w, r, streamPath)
	case http.MethodHead:
		err = h.handleHead(w, r, streamPath)
	case http.MethodGet:
		err = h.handleRead(w, r, streamPath)
	case http.MethodPost:
		err = h.handleAppend(w, r, streamPath)
	case http.MethodDelete:
		err = h.handleDelete(w, r, streamPath)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		return nil
	}

	if err != nil {
		h.writeError(w, err)
	}
	return nil
}

// handleCreate handles PUT requests to create a stream
func (h *Handler) handleCreate(w http.ResponseWriter, r *http.Request, path string) error {
	// Parse headers
	contentType := r.Header.Get("Content-Type")
	ttlStr := r.Header.Get(HeaderStreamTTL)
	expiresAtStr := r.Header.Get(HeaderStreamExpiresAt)

	// Validate TTL and ExpiresAt aren't both provided
	if ttlStr != "" && expiresAtStr != "" {
		return newHTTPError(http.StatusBadRequest, "cannot specify both Stream-TTL and Stream-Expires-At")
	}

	// Parse TTL
	var ttlSeconds *int64
	if ttlStr != "" {
		ttl, err := parseTTL(ttlStr)
		if err != nil {
			return newHTTPError(http.StatusBadRequest, err.Error())
		}
		ttlSeconds = &ttl
	}

	// Parse ExpiresAt
	var expiresAt *time.Time
	if expiresAtStr != "" {
		t, err := time.Parse(time.RFC3339, expiresAtStr)
		if err != nil {
			return newHTTPError(http.StatusBadRequest, "invalid Stream-Expires-At format")
		}
		expiresAt = &t
	}

	// Read optional initial body
	var initialData []byte
	if r.ContentLength > 0 {
		var err error
		initialData, err = io.ReadAll(r.Body)
		if err != nil {
			return newHTTPError(http.StatusBadRequest, "failed to read body")
		}
	}

	opts := store.CreateOptions{
		ContentType: contentType,
		TTLSeconds:  ttlSeconds,
		ExpiresAt:   expiresAt,
		InitialData: initialData,
	}

	meta, wasCreated, err := h.store.Create(path, opts)
	if err != nil {
		if errors.Is(err, store.ErrConfigMismatch) {
			return newHTTPError(http.StatusConflict, "stream exists with different configuration")
		}
		return err
	}

	// Set response headers
	w.Header().Set("Content-Type", meta.ContentType)
	w.Header().Set(HeaderStreamNextOffset, meta.CurrentOffset.String())

	if wasCreated {
		// Build full URL for Location header
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		// Check X-Forwarded-Proto header (for reverse proxies)
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = proto
		}
		fullURL := fmt.Sprintf("%s://%s%s", scheme, r.Host, r.URL.Path)
		w.Header().Set("Location", fullURL)
		w.WriteHeader(http.StatusCreated)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	return nil
}

// handleHead handles HEAD requests for stream metadata
func (h *Handler) handleHead(w http.ResponseWriter, r *http.Request, path string) error {
	meta, err := h.store.Get(path)
	if err != nil {
		if errors.Is(err, store.ErrStreamNotFound) {
			return newHTTPError(http.StatusNotFound, "stream not found")
		}
		return err
	}

	w.Header().Set("Content-Type", meta.ContentType)
	w.Header().Set(HeaderStreamNextOffset, meta.CurrentOffset.String())
	w.Header().Set("Cache-Control", "no-store")

	if meta.TTLSeconds != nil {
		w.Header().Set(HeaderStreamTTL, strconv.FormatInt(*meta.TTLSeconds, 10))
	}
	if meta.ExpiresAt != nil {
		w.Header().Set(HeaderStreamExpiresAt, meta.ExpiresAt.Format(time.RFC3339))
	}

	w.WriteHeader(http.StatusOK)
	return nil
}

// handleRead handles GET requests to read from a stream
func (h *Handler) handleRead(w http.ResponseWriter, r *http.Request, path string) error {
	// Check if stream exists
	meta, err := h.store.Get(path)
	if err != nil {
		if errors.Is(err, store.ErrStreamNotFound) {
			return newHTTPError(http.StatusNotFound, "stream not found")
		}
		return err
	}

	// Check for explicit empty offset parameter (different from missing offset)
	query := r.URL.Query()
	offsetValues, offsetProvided := query["offset"]
	offsetStr := ""
	if offsetProvided {
		if len(offsetValues) > 1 {
			return newHTTPError(http.StatusBadRequest, "multiple offset parameters not allowed")
		}
		offsetStr = offsetValues[0]
		// Reject empty offset string when explicitly provided
		if offsetStr == "" {
			return newHTTPError(http.StatusBadRequest, "offset parameter cannot be empty")
		}
	}

	// Parse offset
	offset, err := store.ParseOffset(offsetStr)
	if err != nil {
		return newHTTPError(http.StatusBadRequest, "invalid offset")
	}

	// Check for live mode
	liveMode := query.Get("live")
	cursor := query.Get("cursor")

	// Validate long-poll requires offset
	if liveMode == "long-poll" && !offsetProvided {
		return newHTTPError(http.StatusBadRequest, "offset required for long-poll mode")
	}

	// Validate SSE requires offset
	if liveMode == "sse" && !offsetProvided {
		return newHTTPError(http.StatusBadRequest, "offset required for SSE mode")
	}

	// Handle SSE mode first (before reading)
	if liveMode == "sse" {
		return h.handleSSE(w, r, path, offset, cursor)
	}

	// Read messages
	messages, _, err := h.store.Read(path, offset)
	if err != nil {
		return err
	}

	// Calculate next offset
	nextOffset := offset
	if len(messages) > 0 {
		nextOffset = messages[len(messages)-1].Offset
	} else {
		// No new messages, use current offset from metadata
		nextOffset = meta.CurrentOffset
	}

	// Handle long-poll mode
	if liveMode == "long-poll" && len(messages) == 0 {
		// Client is caught up, wait for new data
		timeout := time.Duration(h.LongPollTimeout)
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()

		var timedOut bool
		messages, timedOut, err = h.store.WaitForMessages(ctx, path, offset, timeout)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				// Timeout or client disconnect - return 204 with current offset
				w.Header().Set("Content-Type", meta.ContentType)
				w.Header().Set(HeaderStreamNextOffset, offset.String())
				w.Header().Set(HeaderStreamUpToDate, "true")
				w.WriteHeader(http.StatusNoContent)
				return nil
			}
			return err
		}

		if timedOut {
			// Timeout - return 204 with current offset
			w.Header().Set("Content-Type", meta.ContentType)
			w.Header().Set(HeaderStreamNextOffset, offset.String())
			w.Header().Set(HeaderStreamUpToDate, "true")
			w.WriteHeader(http.StatusNoContent)
			return nil
		}

		// Got new messages - update nextOffset
		if len(messages) > 0 {
			nextOffset = messages[len(messages)-1].Offset
		}
	}

	// Determine if we're up to date (at the tail of the stream)
	// Re-fetch current offset to check if we're at the tail
	currentMeta, _ := h.store.Get(path)
	upToDate := nextOffset.Equal(currentMeta.CurrentOffset)

	// Set response headers
	w.Header().Set("Content-Type", meta.ContentType)
	w.Header().Set(HeaderStreamNextOffset, nextOffset.String())

	// Always set Stream-Up-To-Date when at tail
	if upToDate {
		w.Header().Set(HeaderStreamUpToDate, "true")
	}

	// Generate Stream-Cursor for long-poll responses (CDN cache collision prevention)
	if liveMode == "long-poll" {
		responseCursor := generateResponseCursor(cursor)
		w.Header().Set(HeaderStreamCursor, responseCursor)
	}

	// Set ETag for caching
	w.Header().Set("ETag", fmt.Sprintf(`"%s"`, nextOffset.String()))

	// Set caching headers for historical reads
	if !upToDate && len(messages) > 0 {
		w.Header().Set("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
	}

	// Check If-None-Match for 304
	if ifNoneMatch := r.Header.Get("If-None-Match"); ifNoneMatch != "" {
		expectedETag := fmt.Sprintf(`"%s"`, nextOffset.String())
		if ifNoneMatch == expectedETag {
			w.WriteHeader(http.StatusNotModified)
			return nil
		}
	}

	// Format and write response
	body, err := h.formatResponse(path, messages, meta.ContentType)
	if err != nil {
		return err
	}

	w.WriteHeader(http.StatusOK)
	w.Write(body)
	return nil
}

// Cursor epoch: October 9, 2024 00:00:00 UTC
var cursorEpoch = time.Date(2024, 10, 9, 0, 0, 0, 0, time.UTC)

// Default interval duration in seconds
const cursorIntervalSeconds = 20

// Jitter range in seconds (per protocol spec)
const (
	minJitterSeconds = 1
	maxJitterSeconds = 3600
)

// generateCursor generates a time-based interval cursor for cache collision prevention
func generateCursor() string {
	now := time.Now()
	epochMs := cursorEpoch.UnixMilli()
	nowMs := now.UnixMilli()
	intervalMs := cursorIntervalSeconds * 1000

	// Calculate interval number since epoch
	intervalNumber := (nowMs - epochMs) / int64(intervalMs)
	return strconv.FormatInt(intervalNumber, 10)
}

// generateResponseCursor generates a cursor ensuring monotonic progression
func generateResponseCursor(clientCursor string) string {
	currentCursor := generateCursor()
	currentInterval, _ := strconv.ParseInt(currentCursor, 10, 64)

	// No client cursor - return current interval
	if clientCursor == "" {
		return currentCursor
	}

	// Parse client cursor
	clientInterval, err := strconv.ParseInt(clientCursor, 10, 64)
	if err != nil || clientInterval < currentInterval {
		// Invalid or behind current time - return current interval
		return currentCursor
	}

	// Client cursor is at or ahead - add random jitter to advance
	jitterSeconds := minJitterSeconds + (maxJitterSeconds-minJitterSeconds)/2 // Use middle value for simplicity
	jitterIntervals := int64(1)
	if jitterSeconds/cursorIntervalSeconds > 1 {
		jitterIntervals = int64(jitterSeconds / cursorIntervalSeconds)
	}

	return strconv.FormatInt(clientInterval+jitterIntervals, 10)
}

// handleSSE handles Server-Sent Events streaming
func (h *Handler) handleSSE(w http.ResponseWriter, r *http.Request, path string, offset store.Offset, cursor string) error {
	meta, err := h.store.Get(path)
	if err != nil {
		return err
	}

	// Validate content type for SSE (must be text/* or application/json)
	ct := strings.ToLower(store.ExtractMediaType(meta.ContentType))
	if !strings.HasPrefix(ct, "text/") && ct != "application/json" {
		return newHTTPError(http.StatusBadRequest, "SSE mode requires text/* or application/json content type")
	}

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		return newHTTPError(http.StatusInternalServerError, "streaming not supported")
	}

	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	reconnectTimer := time.NewTimer(time.Duration(h.SSEReconnectInterval))
	defer reconnectTimer.Stop()

	currentOffset := offset
	sentInitialControl := false

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-reconnectTimer.C:
			// Close connection to allow CDN collapsing
			return nil
		default:
			// Read any available messages
			messages, _, err := h.store.Read(path, currentOffset)
			if err != nil {
				return err
			}

			if len(messages) > 0 {
				// Send data event
				body, _ := h.formatResponse(path, messages, meta.ContentType)
				fmt.Fprintf(w, "event: data\n")
				for _, line := range strings.Split(string(body), "\n") {
					fmt.Fprintf(w, "data: %s\n", line)
				}
				fmt.Fprintf(w, "\n")

				// Update current offset
				currentOffset = messages[len(messages)-1].Offset

				// Generate cursor with collision handling
				responseCursor := generateResponseCursor(cursor)

				// Send control event
				control := map[string]string{
					"streamNextOffset": currentOffset.String(),
					"streamCursor":     responseCursor,
				}
				controlJSON, _ := json.Marshal(control)
				fmt.Fprintf(w, "event: control\n")
				fmt.Fprintf(w, "data: %s\n\n", controlJSON)

				flusher.Flush()
				sentInitialControl = true
			} else if !sentInitialControl {
				// Send initial control event even for empty stream
				currentMeta, _ := h.store.Get(path)

				// Generate cursor with collision handling
				responseCursor := generateResponseCursor(cursor)

				control := map[string]string{
					"streamNextOffset": currentMeta.CurrentOffset.String(),
					"streamCursor":     responseCursor,
				}
				controlJSON, _ := json.Marshal(control)
				fmt.Fprintf(w, "event: control\n")
				fmt.Fprintf(w, "data: %s\n\n", controlJSON)

				flusher.Flush()
				sentInitialControl = true
			}

			// Wait for more data
			timeout := 100 * time.Millisecond
			waitCtx, cancel := context.WithTimeout(ctx, timeout)
			h.store.WaitForMessages(waitCtx, path, currentOffset, timeout)
			cancel()
		}
	}
}

// handleAppend handles POST requests to append to a stream
func (h *Handler) handleAppend(w http.ResponseWriter, r *http.Request, path string) error {
	// Check if stream exists
	meta, err := h.store.Get(path)
	if err != nil {
		if errors.Is(err, store.ErrStreamNotFound) {
			return newHTTPError(http.StatusNotFound, "stream not found")
		}
		return err
	}

	// Check for Content-Type header - required on POST
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		return newHTTPError(http.StatusBadRequest, "Content-Type header is required")
	}

	// Check if content type matches stream (must validate before reading body)
	if !store.ContentTypeMatches(meta.ContentType, contentType) {
		return newHTTPError(http.StatusConflict, "content type mismatch")
	}

	// Read body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return newHTTPError(http.StatusBadRequest, "failed to read body")
	}

	// Reject empty body
	if len(body) == 0 {
		return newHTTPError(http.StatusBadRequest, "empty body not allowed")
	}

	opts := store.AppendOptions{
		Seq:         r.Header.Get(HeaderStreamSeq),
		ContentType: contentType,
	}

	newOffset, err := h.store.Append(path, body, opts)
	if err != nil {
		if errors.Is(err, store.ErrSequenceConflict) {
			return newHTTPError(http.StatusConflict, "sequence number conflict")
		}
		if errors.Is(err, store.ErrContentTypeMismatch) {
			return newHTTPError(http.StatusConflict, "content type mismatch")
		}
		if errors.Is(err, store.ErrInvalidJSON) {
			return newHTTPError(http.StatusBadRequest, "invalid JSON")
		}
		if errors.Is(err, store.ErrEmptyJSONArray) {
			return newHTTPError(http.StatusBadRequest, "empty JSON array not allowed")
		}
		return err
	}

	w.Header().Set(HeaderStreamNextOffset, newOffset.String())
	w.WriteHeader(http.StatusOK)
	return nil
}

// handleDelete handles DELETE requests to delete a stream
func (h *Handler) handleDelete(w http.ResponseWriter, r *http.Request, path string) error {
	err := h.store.Delete(path)
	if err != nil {
		if errors.Is(err, store.ErrStreamNotFound) {
			return newHTTPError(http.StatusNotFound, "stream not found")
		}
		return err
	}

	w.WriteHeader(http.StatusNoContent)
	return nil
}

// formatResponse formats messages based on content type
func (h *Handler) formatResponse(path string, messages []store.Message, contentType string) ([]byte, error) {
	if store.IsJSONContentType(contentType) {
		return store.FormatJSONResponse(messages), nil
	}

	// Non-JSON: concatenate raw data
	var total int
	for _, msg := range messages {
		total += len(msg.Data)
	}
	result := make([]byte, 0, total)
	for _, msg := range messages {
		result = append(result, msg.Data...)
	}
	return result, nil
}

// HTTP error handling
type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string {
	return e.message
}

func newHTTPError(status int, message string) *httpError {
	return &httpError{status: status, message: message}
}

func (h *Handler) writeError(w http.ResponseWriter, err error) {
	var httpErr *httpError
	if errors.As(err, &httpErr) {
		http.Error(w, httpErr.message, httpErr.status)
		return
	}

	h.logger.Error("internal error", zap.Error(err))
	http.Error(w, "internal server error", http.StatusInternalServerError)
}

// parseTTL parses and validates a TTL string according to the protocol
var ttlRegex = regexp.MustCompile(`^[1-9][0-9]*$|^0$`)

func parseTTL(s string) (int64, error) {
	// Must be a positive integer without leading zeros (except "0" itself)
	// No plus sign, no floats, no scientific notation
	if !ttlRegex.MatchString(s) {
		return 0, fmt.Errorf("invalid TTL format: must be a non-negative integer without leading zeros")
	}

	ttl, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid TTL: %w", err)
	}

	if ttl < 0 {
		return 0, fmt.Errorf("TTL must be non-negative")
	}

	return ttl, nil
}

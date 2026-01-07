package durablestreams

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/durable-streams/durable-streams/packages/client-go/internal/sse"
)

// Chunk represents one HTTP response body from the stream.
type Chunk struct {
	// NextOffset is the position after this chunk.
	// Use this for resumption/checkpointing.
	NextOffset Offset

	// Data is the raw bytes from this response.
	Data []byte

	// UpToDate is true if this chunk ends at stream head.
	UpToDate bool

	// Cursor for CDN collapsing (automatically propagated by iterator).
	Cursor string

	// ETag for conditional requests.
	ETag string
}

// ChunkIterator iterates over raw byte chunks from the stream.
// Call Next() in a loop until it returns Done.
//
// The iterator automatically:
//   - Propagates cursor headers for CDN compatibility
//   - Handles 304 Not Modified responses (advances state, no error)
//   - Handles 204 No Content for long-poll timeouts
//   - Parses SSE events when in SSE mode
//
// Always call Close() when done to release resources.
type ChunkIterator struct {
	stream  *Stream
	ctx     context.Context
	cancel  context.CancelFunc
	offset  Offset
	live    LiveMode
	cursor  string
	headers map[string]string
	timeout time.Duration

	// Public state accessible during iteration
	// Offset is the current position in the stream.
	// Updated after each successful Next() call.
	Offset Offset

	// UpToDate is true when the iterator has caught up to stream head.
	UpToDate bool

	// Cursor is the current cursor value (for debugging/advanced use).
	// The iterator propagates this automatically; most users can ignore it.
	Cursor string

	// Internal state
	mu       sync.Mutex
	closed   bool
	doneOnce bool

	// SSE state
	sseParser   *sse.Parser
	sseResponse *http.Response
	ssePending  *Chunk // Pending chunk from SSE data event
}

// Next returns the next chunk of bytes from the stream.
// Returns Done when iteration is complete (live=false and caught up).
// In live mode, blocks waiting for new data.
//
// Example:
//
//	for {
//	    chunk, err := it.Next()
//	    if errors.Is(err, durablestreams.Done) {
//	        break
//	    }
//	    if err != nil {
//	        return err
//	    }
//	    fmt.Printf("Got %d bytes at offset %s\n", len(chunk.Data), chunk.NextOffset)
//	}
func (it *ChunkIterator) Next() (*Chunk, error) {
	it.mu.Lock()
	if it.closed {
		it.mu.Unlock()
		return nil, ErrAlreadyClosed
	}
	if it.doneOnce {
		it.mu.Unlock()
		return nil, Done
	}
	it.mu.Unlock()

	// Check context
	select {
	case <-it.ctx.Done():
		return nil, it.ctx.Err()
	default:
	}

	// Handle SSE mode
	if it.live == LiveModeSSE {
		return it.nextSSE()
	}

	// Handle catch-up and long-poll modes
	return it.nextHTTP()
}

// nextHTTP handles regular HTTP requests (catch-up and long-poll).
func (it *ChunkIterator) nextHTTP() (*Chunk, error) {
	// Build the read URL
	readURL := it.stream.buildReadURL(it.offset, it.live, it.cursor)

	// Create request
	req, err := http.NewRequestWithContext(it.ctx, http.MethodGet, readURL, nil)
	if err != nil {
		return nil, newStreamError("read", it.stream.url, 0, err)
	}

	// Set custom headers
	for k, v := range it.headers {
		req.Header.Set(k, v)
	}

	// Execute request
	resp, err := it.stream.client.httpClient.Do(req)
	if err != nil {
		// Check if context was cancelled
		if it.ctx.Err() != nil {
			return nil, it.ctx.Err()
		}
		return nil, newStreamError("read", it.stream.url, 0, err)
	}
	defer resp.Body.Close()

	// Handle response status
	switch resp.StatusCode {
	case http.StatusOK:
		// Read body
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, newStreamError("read", it.stream.url, resp.StatusCode, err)
		}

		// Extract headers
		nextOffset := Offset(resp.Header.Get(headerStreamOffset))
		cursor := resp.Header.Get(headerStreamCursor)
		upToDate := resp.Header.Get(headerStreamUpToDate) == "true"
		etag := resp.Header.Get(headerETag)

		// Update iterator state
		it.mu.Lock()
		it.offset = nextOffset
		it.cursor = cursor
		it.Offset = nextOffset
		it.Cursor = cursor
		it.UpToDate = upToDate

		// If up to date and not in live mode, mark as done for next call
		if upToDate && it.live == LiveModeNone {
			it.doneOnce = true
		}
		it.mu.Unlock()

		return &Chunk{
			NextOffset: nextOffset,
			Data:       data,
			UpToDate:   upToDate,
			Cursor:     cursor,
			ETag:       etag,
		}, nil

	case http.StatusNoContent:
		// 204 - Long-poll timeout or caught up with no new data
		nextOffset := Offset(resp.Header.Get(headerStreamOffset))
		cursor := resp.Header.Get(headerStreamCursor)
		upToDate := resp.Header.Get(headerStreamUpToDate) == "true"

		it.mu.Lock()
		if nextOffset != "" {
			it.offset = nextOffset
			it.Offset = nextOffset
		}
		if cursor != "" {
			it.cursor = cursor
			it.Cursor = cursor
		}
		it.UpToDate = upToDate

		// In non-live mode, 204 means we're done
		if it.live == LiveModeNone {
			it.doneOnce = true
			it.mu.Unlock()
			return nil, Done
		}
		it.mu.Unlock()

		// In live mode, return empty chunk and continue
		return &Chunk{
			NextOffset: nextOffset,
			Data:       nil,
			UpToDate:   upToDate,
			Cursor:     cursor,
		}, nil

	case http.StatusNotModified:
		// 304 - Not modified (cache hit)
		// Advance cursor if provided and try again
		if cursor := resp.Header.Get(headerStreamCursor); cursor != "" {
			it.mu.Lock()
			it.cursor = cursor
			it.Cursor = cursor
			it.mu.Unlock()
		}
		// Return empty chunk
		return &Chunk{
			NextOffset: it.offset,
			Data:       nil,
			UpToDate:   it.UpToDate,
			Cursor:     it.cursor,
		}, nil

	case http.StatusNotFound:
		io.Copy(io.Discard, resp.Body)
		return nil, newStreamError("read", it.stream.url, resp.StatusCode, ErrStreamNotFound)

	case http.StatusGone:
		io.Copy(io.Discard, resp.Body)
		return nil, newStreamError("read", it.stream.url, resp.StatusCode, ErrOffsetGone)

	default:
		io.Copy(io.Discard, resp.Body)
		return nil, newStreamError("read", it.stream.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// nextSSE handles SSE streaming mode.
func (it *ChunkIterator) nextSSE() (*Chunk, error) {
	// If we have a pending chunk (data received, waiting for control), return it
	it.mu.Lock()
	if it.ssePending != nil {
		chunk := it.ssePending
		it.ssePending = nil
		it.mu.Unlock()
		return chunk, nil
	}
	it.mu.Unlock()

	// If we don't have an active SSE connection, establish one
	if it.sseParser == nil {
		if err := it.establishSSEConnection(); err != nil {
			return nil, err
		}
	}

	// Read events from SSE stream
	for {
		event, err := it.sseParser.Next()
		if err != nil {
			// Connection closed or error - clean up and reconnect on next call
			it.closeSSEConnection()

			if err == io.EOF {
				// Connection closed gracefully, try to reconnect
				if it.ctx.Err() != nil {
					return nil, it.ctx.Err()
				}
				// Re-establish connection and continue
				if err := it.establishSSEConnection(); err != nil {
					return nil, err
				}
				continue
			}

			if it.ctx.Err() != nil {
				return nil, it.ctx.Err()
			}
			return nil, newStreamError("read", it.stream.url, 0, err)
		}

		switch e := event.(type) {
		case sse.DataEvent:
			// Buffer data, wait for control event to get offset.
			// Multiple data events may arrive before a single control event - accumulate them.
			it.mu.Lock()
			if it.ssePending == nil {
				it.ssePending = &Chunk{
					Data: []byte(e.Data),
				}
			} else {
				// Append to existing pending data
				it.ssePending.Data = append(it.ssePending.Data, []byte(e.Data)...)
			}
			it.mu.Unlock()

		case sse.ControlEvent:
			// Update state from control event
			it.mu.Lock()
			it.offset = Offset(e.StreamNextOffset)
			it.Offset = Offset(e.StreamNextOffset)
			if e.StreamCursor != "" {
				it.cursor = e.StreamCursor
				it.Cursor = e.StreamCursor
			}
			it.UpToDate = e.UpToDate

			// If we have pending data, complete and return it
			if it.ssePending != nil {
				chunk := it.ssePending
				chunk.NextOffset = Offset(e.StreamNextOffset)
				chunk.Cursor = e.StreamCursor
				chunk.UpToDate = e.UpToDate
				it.ssePending = nil
				it.mu.Unlock()
				return chunk, nil
			}
			it.mu.Unlock()

			// Control event without data (e.g., up-to-date signal)
			if e.UpToDate {
				return &Chunk{
					NextOffset: Offset(e.StreamNextOffset),
					Cursor:     e.StreamCursor,
					UpToDate:   true,
				}, nil
			}
		}
	}
}

// establishSSEConnection creates a new SSE connection.
func (it *ChunkIterator) establishSSEConnection() error {
	readURL := it.stream.buildReadURL(it.offset, LiveModeSSE, it.cursor)

	req, err := http.NewRequestWithContext(it.ctx, http.MethodGet, readURL, nil)
	if err != nil {
		return newStreamError("read", it.stream.url, 0, err)
	}

	// Set Accept header for SSE
	req.Header.Set("Accept", "text/event-stream")

	// Set custom headers
	for k, v := range it.headers {
		req.Header.Set(k, v)
	}

	resp, err := it.stream.client.httpClient.Do(req)
	if err != nil {
		if it.ctx.Err() != nil {
			return it.ctx.Err()
		}
		return newStreamError("read", it.stream.url, 0, err)
	}

	// Check response
	switch resp.StatusCode {
	case http.StatusOK:
		// Verify it's actually SSE
		contentType := resp.Header.Get("Content-Type")
		if !strings.HasPrefix(contentType, "text/event-stream") {
			resp.Body.Close()
			return newStreamError("read", it.stream.url, resp.StatusCode,
				ErrContentTypeMismatch)
		}

		it.mu.Lock()
		it.sseResponse = resp
		it.sseParser = sse.NewParser(resp.Body)
		it.mu.Unlock()
		return nil

	case http.StatusBadRequest:
		resp.Body.Close()
		return newStreamError("read", it.stream.url, resp.StatusCode,
			ErrContentTypeMismatch) // SSE not supported for this content type

	case http.StatusNotFound:
		resp.Body.Close()
		return newStreamError("read", it.stream.url, resp.StatusCode, ErrStreamNotFound)

	default:
		resp.Body.Close()
		return newStreamError("read", it.stream.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// closeSSEConnection closes the current SSE connection.
func (it *ChunkIterator) closeSSEConnection() {
	it.mu.Lock()
	defer it.mu.Unlock()

	if it.sseResponse != nil {
		it.sseResponse.Body.Close()
		it.sseResponse = nil
	}
	it.sseParser = nil
}

// Close cancels the iterator and releases resources.
// Always call Close when done, even if iteration completed.
// Implements io.Closer.
func (it *ChunkIterator) Close() error {
	it.mu.Lock()
	defer it.mu.Unlock()

	if it.closed {
		return nil
	}

	it.closed = true
	it.cancel()

	// Close SSE connection if active
	if it.sseResponse != nil {
		it.sseResponse.Body.Close()
		it.sseResponse = nil
	}
	it.sseParser = nil

	return nil
}

// Ensure ChunkIterator implements io.Closer
var _ io.Closer = (*ChunkIterator)(nil)

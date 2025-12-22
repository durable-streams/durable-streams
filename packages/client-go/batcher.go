package durablestreams

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
)

// BatchedStream wraps a Stream to provide automatic batching for appends.
// Multiple concurrent Append calls are automatically combined into a single
// HTTP request, significantly improving throughput for high-frequency writes.
//
// Example:
//
//	batched := durablestreams.NewBatchedStream(stream)
//	defer batched.Close()
//
//	// These may be batched into a single request
//	go batched.Append(ctx, []byte("a"))
//	go batched.Append(ctx, []byte("b"))
//	go batched.Append(ctx, []byte("c"))
type BatchedStream struct {
	stream *Stream

	mu       sync.Mutex
	buffer   []*pendingAppend
	inflight bool
	closed   bool

	// Condition variable for signaling batch completion
	cond *sync.Cond

	// Error from the last batch (cleared on next batch)
	lastErr error
}

// pendingAppend represents a buffered append waiting to be sent.
type pendingAppend struct {
	ctx         context.Context
	data        []byte
	seq         string
	contentType string

	// Channel to signal completion
	done chan error
}

// NewBatchedStream creates a BatchedStream that wraps the given stream.
// Always call Close() when done to release resources.
func NewBatchedStream(stream *Stream) *BatchedStream {
	bs := &BatchedStream{
		stream: stream,
		buffer: make([]*pendingAppend, 0),
	}
	bs.cond = sync.NewCond(&bs.mu)
	return bs
}

// Stream returns the underlying stream.
func (bs *BatchedStream) Stream() *Stream {
	return bs.stream
}

// Append writes data to the stream with automatic batching.
// Multiple concurrent Append calls may be combined into a single HTTP request.
// Returns when the data has been successfully written to the server.
func (bs *BatchedStream) Append(ctx context.Context, data []byte, opts ...AppendOption) (*AppendResult, error) {
	if len(data) == 0 {
		return nil, newStreamError("append", bs.stream.url, 0, ErrEmptyAppend)
	}

	cfg := &appendConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	// Create pending append
	pending := &pendingAppend{
		ctx:         ctx,
		data:        data,
		seq:         cfg.seq,
		contentType: bs.stream.contentType,
		done:        make(chan error, 1),
	}

	bs.mu.Lock()
	if bs.closed {
		bs.mu.Unlock()
		return nil, newStreamError("append", bs.stream.url, 0, ErrAlreadyClosed)
	}

	// Add to buffer
	bs.buffer = append(bs.buffer, pending)

	// If no request in flight, start one
	if !bs.inflight {
		bs.inflight = true
		batch := bs.buffer
		bs.buffer = make([]*pendingAppend, 0)
		bs.mu.Unlock()

		// Process batch in goroutine
		go bs.processBatch(batch)
	} else {
		bs.mu.Unlock()
	}

	// Wait for completion
	select {
	case err := <-pending.done:
		if err != nil {
			return nil, err
		}
		// Note: BatchedStream doesn't return individual offsets per append
		// since multiple appends share one response. Return empty result.
		return &AppendResult{}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// AppendJSON writes JSON data to the stream with automatic batching.
func (bs *BatchedStream) AppendJSON(ctx context.Context, v any, opts ...AppendOption) (*AppendResult, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, newStreamError("append", bs.stream.url, 0, fmt.Errorf("json marshal: %w", err))
	}
	return bs.Append(ctx, data, opts...)
}

// processBatch sends a batch of pending appends as a single HTTP request.
func (bs *BatchedStream) processBatch(batch []*pendingAppend) {
	err := bs.sendBatch(batch)

	// Notify all pending appends
	for _, p := range batch {
		p.done <- err
	}

	// Check for more buffered appends
	bs.mu.Lock()
	if len(bs.buffer) > 0 {
		// More appends came in while we were sending - process them
		nextBatch := bs.buffer
		bs.buffer = make([]*pendingAppend, 0)
		bs.mu.Unlock()
		go bs.processBatch(nextBatch)
	} else {
		bs.inflight = false
		bs.mu.Unlock()
	}
}

// sendBatch sends a batch of appends as a single HTTP request.
func (bs *BatchedStream) sendBatch(batch []*pendingAppend) error {
	if len(batch) == 0 {
		return nil
	}

	// Use first context (all should be similar)
	ctx := batch[0].ctx

	// Check if any context is already cancelled
	for _, p := range batch {
		if p.ctx.Err() != nil {
			return p.ctx.Err()
		}
	}

	// Determine content type
	contentType := bs.stream.contentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Find highest seq number (last non-empty seq)
	var highestSeq string
	for i := len(batch) - 1; i >= 0; i-- {
		if batch[i].seq != "" {
			highestSeq = batch[i].seq
			break
		}
	}

	// Build request body based on content type
	var body []byte
	isJSON := isJSONContentType(contentType)

	if isJSON {
		// For JSON mode: wrap all items in an array
		// Each item in batch.data is already JSON-encoded
		// We need to parse and re-encode as array
		items := make([]json.RawMessage, len(batch))
		for i, p := range batch {
			items[i] = json.RawMessage(p.data)
		}
		var err error
		body, err = json.Marshal(items)
		if err != nil {
			return newStreamError("append", bs.stream.url, 0, fmt.Errorf("batch encode: %w", err))
		}
	} else {
		// For byte mode: concatenate all data
		totalSize := 0
		for _, p := range batch {
			totalSize += len(p.data)
		}
		body = make([]byte, 0, totalSize)
		for _, p := range batch {
			body = append(body, p.data...)
		}
	}

	// Create request
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, bs.stream.url, bytes.NewReader(body))
	if err != nil {
		return newStreamError("append", bs.stream.url, 0, err)
	}

	req.Header.Set(headerContentType, contentType)
	if highestSeq != "" {
		req.Header.Set(headerStreamSeq, highestSeq)
	}

	// Execute with retry
	resp, err := bs.stream.doWithRetry(ctx, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodPost, bs.stream.url, bytes.NewReader(body))
	})
	if err != nil {
		return newStreamError("append", bs.stream.url, 0, err)
	}
	defer resp.Body.Close()

	io.Copy(io.Discard, resp.Body)

	switch resp.StatusCode {
	case http.StatusOK, http.StatusNoContent:
		return nil
	case http.StatusNotFound:
		return newStreamError("append", bs.stream.url, resp.StatusCode, ErrStreamNotFound)
	case http.StatusConflict:
		return newStreamError("append", bs.stream.url, resp.StatusCode, ErrSeqConflict)
	default:
		return newStreamError("append", bs.stream.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// Close stops accepting new appends and waits for pending appends to complete.
func (bs *BatchedStream) Close() error {
	bs.mu.Lock()
	bs.closed = true

	// Wait for inflight batch to complete
	for bs.inflight {
		bs.cond.Wait()
	}
	bs.mu.Unlock()

	return nil
}

// isJSONContentType checks if the content type is JSON.
func isJSONContentType(ct string) bool {
	// Simple check - could be more robust
	return ct == "application/json" ||
		len(ct) > 16 && ct[:16] == "application/json"
}

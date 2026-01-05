package durablestreams

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// normalizeContentType extracts media type before semicolon and lowercases.
func normalizeContentType(contentType string) string {
	if contentType == "" {
		return ""
	}
	idx := strings.Index(contentType, ";")
	if idx >= 0 {
		contentType = contentType[:idx]
	}
	return strings.TrimSpace(strings.ToLower(contentType))
}

// Producer header constants
const (
	headerProducerID          = "Producer-Id"
	headerProducerEpoch       = "Producer-Epoch"
	headerProducerSeq         = "Producer-Seq"
	headerProducerExpectedSeq = "Producer-Expected-Seq"
	headerProducerReceivedSeq = "Producer-Received-Seq"
)

// Errors for idempotent producer operations
var (
	// ErrProducerClosed is returned when append is called on a closed producer.
	ErrProducerClosed = errors.New("producer is closed")

	// ErrStaleEpoch is returned when the producer's epoch is stale (zombie fencing).
	ErrStaleEpoch = errors.New("producer epoch is stale")

	// ErrSequenceGap is returned when a sequence gap is detected.
	ErrSequenceGap = errors.New("sequence gap detected")
)

// StaleEpochError provides details about a stale epoch rejection.
type StaleEpochError struct {
	// CurrentEpoch is the epoch the server has for this producer.
	CurrentEpoch int
}

func (e *StaleEpochError) Error() string {
	return fmt.Sprintf("producer epoch is stale: server has epoch %d", e.CurrentEpoch)
}

func (e *StaleEpochError) Unwrap() error {
	return ErrStaleEpoch
}

// SequenceGapError provides details about a sequence gap.
type SequenceGapError struct {
	ExpectedSeq int
	ReceivedSeq int
}

func (e *SequenceGapError) Error() string {
	return fmt.Sprintf("sequence gap: expected %d, received %d", e.ExpectedSeq, e.ReceivedSeq)
}

func (e *SequenceGapError) Unwrap() error {
	return ErrSequenceGap
}

// IdempotentAppendResult contains the result of an idempotent append.
type IdempotentAppendResult struct {
	// Offset is the stream offset after append (empty for duplicates).
	Offset Offset

	// Duplicate is true if this was a duplicate (204 response).
	Duplicate bool
}

// pendingEntry represents a message waiting to be sent.
type pendingEntry struct {
	data   []byte
	// For JSON mode, store the raw JSON value for proper array wrapping
	jsonData json.RawMessage
	result   chan idempotentResult
}

type idempotentResult struct {
	result IdempotentAppendResult
	err    error
}

// IdempotentProducerConfig configures an idempotent producer.
type IdempotentProducerConfig struct {
	// Epoch is the starting epoch (default 0).
	Epoch int

	// AutoClaim enables automatic epoch claiming on 403.
	AutoClaim bool

	// MaxBatchBytes is the maximum batch size before sending (default 1MB).
	MaxBatchBytes int

	// LingerMs is the maximum time to wait before sending a batch (default 5ms).
	LingerMs int

	// MaxInFlight is the maximum concurrent batches (default 5).
	MaxInFlight int

	// ContentType is the content type for appends (default "application/octet-stream").
	ContentType string

	// OnError is called when a batch fails. Use with AppendAsync for fire-and-forget.
	// If nil, errors are only returned from Append (blocking) or discarded by AppendAsync.
	OnError func(error)
}

// DefaultIdempotentProducerConfig returns the default configuration.
func DefaultIdempotentProducerConfig() IdempotentProducerConfig {
	return IdempotentProducerConfig{
		Epoch:         0,
		AutoClaim:     false,
		MaxBatchBytes: 1024 * 1024,
		LingerMs:      5,
		MaxInFlight:   5,
		ContentType:   "application/octet-stream",
	}
}

// IdempotentProducer provides exactly-once write semantics using Kafka-style
// producer IDs, epochs, and sequence numbers.
//
// Features:
//   - Fire-and-forget: Append returns immediately, batches in background
//   - Exactly-once: Server deduplicates using (producerId, epoch, seq)
//   - Batching: Multiple appends batched into single HTTP request
//   - Pipelining: Up to MaxInFlight concurrent batches
//   - Zombie fencing: Stale producers rejected via epoch validation
//
// Example:
//
//	producer := client.IdempotentProducer(streamURL, "order-service-1", IdempotentProducerConfig{
//	    Epoch:     0,
//	    AutoClaim: true,
//	})
//	defer producer.Close()
//
//	// Fire-and-forget writes
//	result1, err := producer.Append(ctx, []byte("message 1"))
//	result2, err := producer.Append(ctx, []byte("message 2"))
//
//	// Ensure all messages are delivered
//	err = producer.Flush(ctx)
type IdempotentProducer struct {
	url        string
	producerID string
	client     *Client
	config     IdempotentProducerConfig

	mu       sync.Mutex
	epoch    int
	nextSeq  int
	closed   bool
	closedCh chan struct{}

	// Batching state
	pendingBatch []pendingEntry
	batchBytes   int
	lingerTimer  *time.Timer

	// Pipelining state
	inFlight   int
	inFlightWg sync.WaitGroup
}

// ErrAutoClaimConcurrency is returned when autoClaim is enabled with maxInFlight > 1.
var ErrAutoClaimConcurrency = errors.New("autoClaim requires MaxInFlight=1; concurrent batches would race to claim epochs")

// IdempotentProducer creates a new idempotent producer for a stream.
// Returns an error if autoClaim is enabled with MaxInFlight > 1 (unsafe configuration).
func (c *Client) IdempotentProducer(url, producerID string, config IdempotentProducerConfig) (*IdempotentProducer, error) {
	if config.MaxBatchBytes == 0 {
		config.MaxBatchBytes = 1024 * 1024
	}
	if config.LingerMs == 0 {
		config.LingerMs = 5
	}
	if config.MaxInFlight == 0 {
		config.MaxInFlight = 5
	}
	if config.ContentType == "" {
		config.ContentType = "application/octet-stream"
	}

	// Guardrail: autoClaim + MaxInFlight > 1 is unsafe
	// Multiple concurrent batches hitting 403 would race to claim epochs
	if config.AutoClaim && config.MaxInFlight > 1 {
		return nil, ErrAutoClaimConcurrency
	}

	return &IdempotentProducer{
		url:        url,
		producerID: producerID,
		client:     c,
		config:     config,
		epoch:      config.Epoch,
		closedCh:   make(chan struct{}),
	}, nil
}

// Epoch returns the current epoch.
func (p *IdempotentProducer) Epoch() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.epoch
}

// NextSeq returns the next sequence number to be assigned.
func (p *IdempotentProducer) NextSeq() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.nextSeq
}

// PendingCount returns the number of messages in the pending batch.
func (p *IdempotentProducer) PendingCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.pendingBatch)
}

// InFlightCount returns the number of batches currently in flight.
func (p *IdempotentProducer) InFlightCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inFlight
}

// Append adds data to the stream with exactly-once semantics.
// The message is batched and sent when:
//   - MaxBatchBytes is reached
//   - LingerMs elapses
//   - Flush is called
//
// Returns the result when the batch containing this message is acknowledged.
func (p *IdempotentProducer) Append(ctx context.Context, data []byte) (*IdempotentAppendResult, error) {
	resultCh := make(chan idempotentResult, 1)

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrProducerClosed
	}

	// For JSON mode, validate and store parsed JSON for proper batching
	isJSON := normalizeContentType(p.config.ContentType) == "application/json"
	var jsonData json.RawMessage
	if isJSON {
		// Validate JSON
		if !json.Valid(data) {
			p.mu.Unlock()
			return nil, newStreamError("append", p.url, 0, fmt.Errorf("invalid JSON"))
		}
		jsonData = json.RawMessage(data)
	}

	// Add to pending batch
	entry := pendingEntry{
		data:     data,
		jsonData: jsonData,
		result:   resultCh,
	}
	p.pendingBatch = append(p.pendingBatch, entry)
	p.batchBytes += len(data)

	// Check if batch should be sent immediately
	shouldSend := p.batchBytes >= p.config.MaxBatchBytes
	shouldStartTimer := !shouldSend && p.lingerTimer == nil

	if shouldSend {
		p.sendCurrentBatchLocked()
	} else if shouldStartTimer {
		p.lingerTimer = time.AfterFunc(time.Duration(p.config.LingerMs)*time.Millisecond, func() {
			p.mu.Lock()
			p.lingerTimer = nil
			if len(p.pendingBatch) > 0 {
				p.sendCurrentBatchLocked()
			}
			p.mu.Unlock()
		})
	}
	p.mu.Unlock()

	// Wait for result
	select {
	case res := <-resultCh:
		if res.err != nil {
			return nil, res.err
		}
		return &res.result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.closedCh:
		return nil, ErrProducerClosed
	}
}

// AppendAsync adds data to the stream without waiting for acknowledgment.
// This is fire-and-forget: returns immediately after adding to the batch.
// Errors are reported via OnError callback if configured.
// Returns ErrProducerClosed if the producer is closed.
func (p *IdempotentProducer) AppendAsync(data []byte) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return ErrProducerClosed
	}

	// For JSON mode, validate and store parsed JSON for proper batching
	isJSON := normalizeContentType(p.config.ContentType) == "application/json"
	var jsonData json.RawMessage
	if isJSON {
		// Validate JSON
		if !json.Valid(data) {
			p.mu.Unlock()
			return newStreamError("append", p.url, 0, fmt.Errorf("invalid JSON"))
		}
		jsonData = json.RawMessage(data)
	}

	// Add to pending batch (no result channel needed for async)
	entry := pendingEntry{
		data:     data,
		jsonData: jsonData,
		result:   nil, // nil signals fire-and-forget
	}
	p.pendingBatch = append(p.pendingBatch, entry)
	p.batchBytes += len(data)

	// Check if batch should be sent immediately
	shouldSend := p.batchBytes >= p.config.MaxBatchBytes
	shouldStartTimer := !shouldSend && p.lingerTimer == nil

	if shouldSend {
		p.sendCurrentBatchLocked()
	} else if shouldStartTimer {
		p.lingerTimer = time.AfterFunc(time.Duration(p.config.LingerMs)*time.Millisecond, func() {
			p.mu.Lock()
			p.lingerTimer = nil
			if len(p.pendingBatch) > 0 {
				p.sendCurrentBatchLocked()
			}
			p.mu.Unlock()
		})
	}
	p.mu.Unlock()

	return nil
}

// Flush sends any pending batch and waits for all in-flight batches to complete.
func (p *IdempotentProducer) Flush(ctx context.Context) error {
	p.mu.Lock()

	// Cancel linger timer
	if p.lingerTimer != nil {
		p.lingerTimer.Stop()
		p.lingerTimer = nil
	}

	// Send pending batch
	if len(p.pendingBatch) > 0 {
		p.sendCurrentBatchLocked()
	}
	p.mu.Unlock()

	// Wait for all in-flight to complete
	done := make(chan struct{})
	go func() {
		p.inFlightWg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close flushes pending messages and closes the producer.
// After Close, further Append calls will return ErrProducerClosed.
func (p *IdempotentProducer) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	close(p.closedCh)
	p.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return p.Flush(ctx)
}

// Restart increments the epoch and resets the sequence.
// Call this when restarting the producer to establish a new session.
func (p *IdempotentProducer) Restart(ctx context.Context) error {
	if err := p.Flush(ctx); err != nil {
		return err
	}

	p.mu.Lock()
	p.epoch++
	p.nextSeq = 0
	p.mu.Unlock()
	return nil
}

// sendCurrentBatchLocked sends the current batch. Caller must hold p.mu.
func (p *IdempotentProducer) sendCurrentBatchLocked() {
	if len(p.pendingBatch) == 0 {
		return
	}

	// Wait if at in-flight limit
	if p.inFlight >= p.config.MaxInFlight {
		return
	}

	// Take the current batch
	batch := p.pendingBatch
	seq := p.nextSeq

	p.pendingBatch = nil
	p.batchBytes = 0
	p.nextSeq++
	p.inFlight++
	p.inFlightWg.Add(1)

	// Send in background
	go func() {
		defer func() {
			p.mu.Lock()
			p.inFlight--
			p.inFlightWg.Done()

			// Try to send pending batch if any
			if len(p.pendingBatch) > 0 && p.inFlight < p.config.MaxInFlight {
				p.sendCurrentBatchLocked()
			}
			p.mu.Unlock()
		}()

		result, err := p.doSendBatch(context.Background(), batch, seq, p.epoch)

		// Call OnError callback if configured and error occurred
		if err != nil && p.config.OnError != nil {
			p.config.OnError(err)
		}

		// Notify entries with result channels (skip nil for async appends)
		res := idempotentResult{err: err}
		if err == nil {
			res.result = result
		}
		for _, entry := range batch {
			if entry.result != nil {
				select {
				case entry.result <- res:
				default:
				}
			}
		}
	}()
}

// doSendBatch sends a batch to the server.
func (p *IdempotentProducer) doSendBatch(ctx context.Context, batch []pendingEntry, seq, epoch int) (IdempotentAppendResult, error) {
	isJSON := normalizeContentType(p.config.ContentType) == "application/json"

	var batchedBody []byte
	if isJSON {
		// For JSON mode: always send as array (server flattens one level)
		// Single append: [value] → server stores value
		// Multiple appends: [val1, val2] → server stores val1, val2
		values := make([]json.RawMessage, len(batch))
		for i, e := range batch {
			values[i] = e.jsonData
		}
		var err error
		batchedBody, err = json.Marshal(values)
		if err != nil {
			return IdempotentAppendResult{}, fmt.Errorf("json batch encode: %w", err)
		}
	} else {
		// For byte mode: concatenate all chunks
		var totalSize int
		for _, e := range batch {
			totalSize += len(e.data)
		}
		batchedBody = make([]byte, 0, totalSize)
		for _, e := range batch {
			batchedBody = append(batchedBody, e.data...)
		}
	}

	// Build request
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(batchedBody))
	if err != nil {
		return IdempotentAppendResult{}, err
	}

	req.Header.Set(headerContentType, p.config.ContentType)
	req.Header.Set(headerProducerID, p.producerID)
	req.Header.Set(headerProducerEpoch, strconv.Itoa(epoch))
	req.Header.Set(headerProducerSeq, strconv.Itoa(seq))

	// Send request
	resp, err := p.client.httpClient.Do(req)
	if err != nil {
		return IdempotentAppendResult{}, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	// Handle response
	switch resp.StatusCode {
	case http.StatusNoContent:
		// Duplicate - idempotent success
		return IdempotentAppendResult{Offset: "", Duplicate: true}, nil

	case http.StatusOK:
		// Success
		offset := Offset(resp.Header.Get(headerStreamOffset))
		return IdempotentAppendResult{Offset: offset, Duplicate: false}, nil

	case http.StatusForbidden:
		// Stale epoch
		currentEpochStr := resp.Header.Get(headerProducerEpoch)
		currentEpoch := epoch
		if currentEpochStr != "" {
			if parsed, err := strconv.Atoi(currentEpochStr); err == nil {
				currentEpoch = parsed
			}
		}

		if p.config.AutoClaim {
			// Auto-claim: retry with epoch+1
			newEpoch := currentEpoch + 1
			p.mu.Lock()
			p.epoch = newEpoch
			p.nextSeq = 1 // This batch uses seq 0
			p.mu.Unlock()

			return p.doSendBatch(ctx, batch, 0, newEpoch)
		}

		return IdempotentAppendResult{}, &StaleEpochError{CurrentEpoch: currentEpoch}

	case http.StatusConflict:
		// Sequence gap
		expectedSeqStr := resp.Header.Get(headerProducerExpectedSeq)
		receivedSeqStr := resp.Header.Get(headerProducerReceivedSeq)
		expectedSeq := 0
		receivedSeq := seq
		if expectedSeqStr != "" {
			if parsed, err := strconv.Atoi(expectedSeqStr); err == nil {
				expectedSeq = parsed
			}
		}
		if receivedSeqStr != "" {
			if parsed, err := strconv.Atoi(receivedSeqStr); err == nil {
				receivedSeq = parsed
			}
		}

		return IdempotentAppendResult{}, &SequenceGapError{
			ExpectedSeq: expectedSeq,
			ReceivedSeq: receivedSeq,
		}

	case http.StatusBadRequest:
		return IdempotentAppendResult{}, newStreamError("append", p.url, resp.StatusCode, ErrBadRequest)

	default:
		return IdempotentAppendResult{}, newStreamError("append", p.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

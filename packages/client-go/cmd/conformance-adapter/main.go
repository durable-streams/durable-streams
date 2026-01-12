// Package main implements the conformance test adapter for the Go client.
//
// This adapter communicates with the test runner via stdin/stdout using
// a JSON-line protocol. Run with:
//
//	go run ./cmd/conformance-adapter
//
// Or build and run:
//
//	go build -o adapter ./cmd/conformance-adapter
//	./adapter
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	durablestreams "github.com/durable-streams/durable-streams/packages/client-go"
)

const clientVersion = "0.1.0"

// Command types from the test runner
type Command struct {
	Type      string            `json:"type"`
	ServerURL string            `json:"serverUrl,omitempty"`
	TimeoutMs int               `json:"timeoutMs,omitempty"`
	Path      string            `json:"path,omitempty"`
	// Create fields
	ContentType string `json:"contentType,omitempty"`
	TTLSeconds  int    `json:"ttlSeconds,omitempty"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
	// Append fields
	Data   string `json:"data,omitempty"`
	Binary bool   `json:"binary,omitempty"`
	Seq    int    `json:"seq,omitempty"`
	// IdempotentProducer fields
	ProducerID  string   `json:"producerId,omitempty"`
	Epoch       int      `json:"epoch,omitempty"`
	AutoClaim   bool     `json:"autoClaim,omitempty"`
	MaxInFlight int      `json:"maxInFlight,omitempty"`
	Items       []string `json:"items,omitempty"` // Already strings - runner extracts data field
	// Read fields
	Offset          string `json:"offset,omitempty"`
	Live            any    `json:"live,omitempty"` // false | "long-poll" | "sse"
	MaxChunks       int    `json:"maxChunks,omitempty"`
	WaitForUpToDate bool   `json:"waitForUpToDate,omitempty"`
	// Benchmark fields
	IterationID string              `json:"iterationId,omitempty"`
	Operation   *BenchmarkOperation `json:"operation,omitempty"`
	// Headers
	Headers map[string]string `json:"headers,omitempty"`
	// Dynamic header/param fields
	Name         string `json:"name,omitempty"`
	ValueType    string `json:"valueType,omitempty"` // "counter" | "timestamp" | "token"
	InitialValue string `json:"initialValue,omitempty"`
	// Validate fields
	Target *ValidateTarget `json:"target,omitempty"`
}

// ValidateTarget for input validation testing
type ValidateTarget struct {
	Target        string `json:"target"` // "retry-options" | "idempotent-producer"
	ProducerID    string `json:"producerId,omitempty"`
	Epoch         *int   `json:"epoch,omitempty"`
	MaxBatchBytes *int   `json:"maxBatchBytes,omitempty"`
	MaxRetries    *int   `json:"maxRetries,omitempty"`
}

// BenchmarkOperation represents a benchmark operation
type BenchmarkOperation struct {
	Op          string `json:"op"`
	Path        string `json:"path,omitempty"`
	Size        int    `json:"size,omitempty"`
	Offset      string `json:"offset,omitempty"`
	Live        string `json:"live,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Count       int    `json:"count,omitempty"`
	Concurrency int    `json:"concurrency,omitempty"`
}

// Result types sent back to test runner
type Result struct {
	Type          string            `json:"type"`
	Success       bool              `json:"success"`
	ClientName    string            `json:"clientName,omitempty"`
	ClientVersion string            `json:"clientVersion,omitempty"`
	Features      *Features         `json:"features,omitempty"`
	Status        int               `json:"status,omitempty"`
	Offset        string            `json:"offset,omitempty"`
	ContentType   string            `json:"contentType,omitempty"`
	Chunks        []ReadChunk       `json:"chunks"`
	UpToDate      bool              `json:"upToDate"`
	Cursor        string            `json:"cursor,omitempty"`
	Headers       map[string]string `json:"headers,omitempty"`
	CommandType   string            `json:"commandType,omitempty"`
	ErrorCode     string            `json:"errorCode,omitempty"`
	Message       string            `json:"message,omitempty"`
	// IdempotentProducer fields
	Duplicate bool `json:"duplicate,omitempty"`
	// Benchmark fields
	IterationID string            `json:"iterationId,omitempty"`
	DurationNs  string            `json:"durationNs,omitempty"`
	Metrics     *BenchmarkMetrics `json:"metrics,omitempty"`
	// Dynamic header/param tracking
	HeadersSent map[string]string `json:"headersSent,omitempty"`
	ParamsSent  map[string]string `json:"paramsSent,omitempty"`
}

// BenchmarkMetrics contains optional benchmark metrics
type BenchmarkMetrics struct {
	BytesTransferred  int     `json:"bytesTransferred,omitempty"`
	MessagesProcessed int     `json:"messagesProcessed,omitempty"`
	OpsPerSecond      float64 `json:"opsPerSecond,omitempty"`
	BytesPerSecond    float64 `json:"bytesPerSecond,omitempty"`
}

type Features struct {
	Batching       bool `json:"batching"`
	SSE            bool `json:"sse"`
	LongPoll       bool `json:"longPoll"`
	Streaming      bool `json:"streaming"`
	DynamicHeaders bool `json:"dynamicHeaders"`
}

type ReadChunk struct {
	Data   string `json:"data"`
	Binary bool   `json:"binary,omitempty"`
	Offset string `json:"offset,omitempty"`
}

// Custom JSON marshaling to ensure Chunks is [] not null for read results
func (r Result) MarshalJSON() ([]byte, error) {
	type Alias Result
	alias := Alias(r)
	// Ensure Chunks is always an array for read results
	if alias.Type == "read" && alias.Chunks == nil {
		alias.Chunks = []ReadChunk{}
	}
	return json.Marshal(alias)
}

var (
	serverURL          string
	client             *durablestreams.Client
	streamContentTypes = make(map[string]string)
)

// normalizeContentType extracts the media type before semicolon and lowercases.
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

// Dynamic header/param state
type DynamicValue struct {
	Type       string // "counter", "timestamp", "token"
	Counter    int
	TokenValue string
}

var (
	dynamicHeaders = make(map[string]*DynamicValue)
	dynamicParams  = make(map[string]*DynamicValue)
)

// resolveDynamicHeaders evaluates all dynamic headers and returns the values
func resolveDynamicHeaders() map[string]string {
	result := make(map[string]string)
	for name, dv := range dynamicHeaders {
		switch dv.Type {
		case "counter":
			dv.Counter++
			result[name] = strconv.Itoa(dv.Counter)
		case "timestamp":
			result[name] = strconv.FormatInt(time.Now().UnixMilli(), 10)
		case "token":
			result[name] = dv.TokenValue
		}
	}
	return result
}

// resolveDynamicParams evaluates all dynamic params and returns the values
func resolveDynamicParams() map[string]string {
	result := make(map[string]string)
	for name, dv := range dynamicParams {
		switch dv.Type {
		case "counter":
			dv.Counter++
			result[name] = strconv.Itoa(dv.Counter)
		case "timestamp":
			result[name] = strconv.FormatInt(time.Now().UnixMilli(), 10)
		}
	}
	return result
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// Increase buffer size for large messages
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var cmd Command
		if err := json.Unmarshal([]byte(line), &cmd); err != nil {
			sendError("unknown", "PARSE_ERROR", fmt.Sprintf("failed to parse command: %v", err))
			continue
		}

		result := handleCommand(cmd)
		output, _ := json.Marshal(result)
		fmt.Println(string(output))

		if cmd.Type == "shutdown" {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "scanner error: %v\n", err)
		os.Exit(1)
	}
}

func handleCommand(cmd Command) Result {
	switch cmd.Type {
	case "init":
		return handleInit(cmd)
	case "create":
		return handleCreate(cmd)
	case "connect":
		return handleConnect(cmd)
	case "append":
		return handleAppend(cmd)
	case "read":
		return handleRead(cmd)
	case "head":
		return handleHead(cmd)
	case "delete":
		return handleDelete(cmd)
	case "benchmark":
		return handleBenchmark(cmd)
	case "set-dynamic-header":
		return handleSetDynamicHeader(cmd)
	case "set-dynamic-param":
		return handleSetDynamicParam(cmd)
	case "clear-dynamic":
		return handleClearDynamic(cmd)
	case "idempotent-append":
		return handleIdempotentAppend(cmd)
	case "idempotent-append-batch":
		return handleIdempotentAppendBatch(cmd)
	case "validate":
		return handleValidate(cmd)
	case "shutdown":
		return Result{Type: "shutdown", Success: true}
	default:
		return sendError(cmd.Type, "NOT_SUPPORTED", fmt.Sprintf("unknown command type: %s", cmd.Type))
	}
}

func handleInit(cmd Command) Result {
	serverURL = cmd.ServerURL
	streamContentTypes = make(map[string]string)
	dynamicHeaders = make(map[string]*DynamicValue)
	dynamicParams = make(map[string]*DynamicValue)
	client = durablestreams.NewClient(
		durablestreams.WithBaseURL(serverURL),
	)

	return Result{
		Type:          "init",
		Success:       true,
		ClientName:    "durable-streams-go",
		ClientVersion: clientVersion,
		Features: &Features{
			Batching:       true,
			SSE:            true,
			LongPoll:       true,
			Streaming:      true,
			DynamicHeaders: true,
		},
	}
}

func handleCreate(cmd Command) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream := client.Stream(cmd.Path)

	contentType := cmd.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Check if stream already exists
	alreadyExists := false
	if _, err := stream.Head(ctx); err == nil {
		alreadyExists = true
	}

	opts := []durablestreams.CreateOption{
		durablestreams.WithContentType(contentType),
	}

	if cmd.TTLSeconds > 0 {
		opts = append(opts, durablestreams.WithTTL(time.Duration(cmd.TTLSeconds)*time.Second))
	}
	if cmd.ExpiresAt != "" {
		if t, err := time.Parse(time.RFC3339, cmd.ExpiresAt); err == nil {
			opts = append(opts, durablestreams.WithExpiresAt(t))
		}
	}
	if len(cmd.Headers) > 0 {
		opts = append(opts, durablestreams.WithCreateHeaders(cmd.Headers))
	}

	err := stream.Create(ctx, opts...)
	if err != nil {
		return errorResult("create", err)
	}

	// Cache content type
	streamContentTypes[cmd.Path] = contentType

	// Get the offset after creation
	meta, err := stream.Head(ctx)
	if err != nil {
		return errorResult("create", err)
	}

	status := 201
	if alreadyExists {
		status = 200
	}

	return Result{
		Type:    "create",
		Success: true,
		Status:  status,
		Offset:  string(meta.NextOffset),
	}
}

func handleConnect(cmd Command) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream := client.Stream(cmd.Path)

	var headOpts []durablestreams.HeadOption
	if len(cmd.Headers) > 0 {
		headOpts = append(headOpts, durablestreams.WithHeadHeaders(cmd.Headers))
	}

	meta, err := stream.Head(ctx, headOpts...)
	if err != nil {
		return errorResult("connect", err)
	}

	// Cache content type
	if meta.ContentType != "" {
		streamContentTypes[cmd.Path] = meta.ContentType
	}

	return Result{
		Type:    "connect",
		Success: true,
		Status:  200,
		Offset:  string(meta.NextOffset),
	}
}

func handleAppend(cmd Command) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream := client.Stream(cmd.Path)

	// Set content type from cache
	if ct, ok := streamContentTypes[cmd.Path]; ok {
		stream.SetContentType(ct)
	}

	// Resolve dynamic headers/params
	headersSent := resolveDynamicHeaders()
	paramsSent := resolveDynamicParams()

	// Get data
	var data []byte
	if cmd.Binary {
		var err error
		data, err = base64.StdEncoding.DecodeString(cmd.Data)
		if err != nil {
			return sendError("append", "PARSE_ERROR", fmt.Sprintf("failed to decode base64: %v", err))
		}
	} else {
		data = []byte(cmd.Data)
	}

	// Merge dynamic headers with command headers
	mergedHeaders := make(map[string]string)
	for k, v := range headersSent {
		mergedHeaders[k] = v
	}
	for k, v := range cmd.Headers {
		mergedHeaders[k] = v
	}

	var opts []durablestreams.AppendOption
	if cmd.Seq > 0 {
		opts = append(opts, durablestreams.WithSeq(strconv.Itoa(cmd.Seq)))
	}
	if len(mergedHeaders) > 0 {
		opts = append(opts, durablestreams.WithAppendHeaders(mergedHeaders))
	}

	result, err := stream.Append(ctx, data, opts...)
	if err != nil {
		return errorResult("append", err)
	}

	res := Result{
		Type:    "append",
		Success: true,
		Status:  200,
		Offset:  string(result.NextOffset),
	}
	if len(headersSent) > 0 {
		res.HeadersSent = headersSent
	}
	if len(paramsSent) > 0 {
		res.ParamsSent = paramsSent
	}
	return res
}

func handleRead(cmd Command) Result {
	timeoutMs := cmd.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 5000
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	stream := client.Stream(cmd.Path)

	// Resolve dynamic headers/params
	headersSent := resolveDynamicHeaders()
	paramsSent := resolveDynamicParams()

	// Merge dynamic headers with command headers
	mergedHeaders := make(map[string]string)
	for k, v := range headersSent {
		mergedHeaders[k] = v
	}
	for k, v := range cmd.Headers {
		mergedHeaders[k] = v
	}

	// Determine live mode
	var liveMode durablestreams.LiveMode
	switch v := cmd.Live.(type) {
	case string:
		switch v {
		case "long-poll":
			liveMode = durablestreams.LiveModeLongPoll
		case "sse":
			liveMode = durablestreams.LiveModeSSE
		}
	case bool:
		if !v {
			liveMode = durablestreams.LiveModeNone
		}
	}

	opts := []durablestreams.ReadOption{
		durablestreams.WithLive(liveMode),
		durablestreams.WithReadTimeout(time.Duration(timeoutMs) * time.Millisecond),
	}

	if cmd.Offset != "" {
		opts = append(opts, durablestreams.WithOffset(durablestreams.Offset(cmd.Offset)))
	}
	if len(mergedHeaders) > 0 {
		opts = append(opts, durablestreams.WithReadHeaders(mergedHeaders))
	}

	it := stream.Read(ctx, opts...)
	defer it.Close()

	chunks := make([]ReadChunk, 0) // Ensure empty array, not null
	maxChunks := cmd.MaxChunks
	if maxChunks == 0 {
		maxChunks = 100
	}

	var finalOffset string
	upToDate := false
	status := 200 // Default status

	for len(chunks) < maxChunks {
		chunk, err := it.Next()
		if err != nil {
			if errors.Is(err, durablestreams.Done) {
				upToDate = true
				finalOffset = string(it.Offset)
				break
			}
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				// Timeout - we've caught up (no new data within timeout)
				upToDate = true
				finalOffset = string(it.Offset)
				status = 204 // Timeout returns 204
				break
			}
			return errorResult("read", err)
		}

		// Track the actual HTTP status from the chunk
		if chunk.StatusCode != 0 {
			status = chunk.StatusCode
		}

		if len(chunk.Data) > 0 {
			chunks = append(chunks, ReadChunk{
				Data:   string(chunk.Data),
				Offset: string(chunk.NextOffset),
			})
		}

		finalOffset = string(chunk.NextOffset)
		upToDate = chunk.UpToDate

		// For waitForUpToDate, stop when we've reached up-to-date
		if cmd.WaitForUpToDate && chunk.UpToDate {
			break
		}

		// In non-live mode, if we got upToDate, we're done
		if liveMode == durablestreams.LiveModeNone && chunk.UpToDate {
			break
		}
	}

	// If no offset was set, use the initial one
	if finalOffset == "" {
		if cmd.Offset != "" {
			finalOffset = cmd.Offset
		} else {
			finalOffset = "-1"
		}
	}

	res := Result{
		Type:     "read",
		Success:  true,
		Status:   status,
		Chunks:   chunks,
		Offset:   finalOffset,
		UpToDate: upToDate,
	}
	if len(headersSent) > 0 {
		res.HeadersSent = headersSent
	}
	if len(paramsSent) > 0 {
		res.ParamsSent = paramsSent
	}
	return res
}

func handleHead(cmd Command) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream := client.Stream(cmd.Path)

	var opts []durablestreams.HeadOption
	if len(cmd.Headers) > 0 {
		opts = append(opts, durablestreams.WithHeadHeaders(cmd.Headers))
	}

	meta, err := stream.Head(ctx, opts...)
	if err != nil {
		return errorResult("head", err)
	}

	return Result{
		Type:        "head",
		Success:     true,
		Status:      200,
		Offset:      string(meta.NextOffset),
		ContentType: meta.ContentType,
	}
}

func handleDelete(cmd Command) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream := client.Stream(cmd.Path)

	var opts []durablestreams.DeleteOption
	if len(cmd.Headers) > 0 {
		opts = append(opts, durablestreams.WithDeleteHeaders(cmd.Headers))
	}

	err := stream.Delete(ctx, opts...)
	if err != nil {
		return errorResult("delete", err)
	}

	// Remove from cache
	delete(streamContentTypes, cmd.Path)

	return Result{
		Type:    "delete",
		Success: true,
		Status:  200,
	}
}

func handleSetDynamicHeader(cmd Command) Result {
	dynamicHeaders[cmd.Name] = &DynamicValue{
		Type:       cmd.ValueType,
		Counter:    0,
		TokenValue: cmd.InitialValue,
	}
	return Result{
		Type:    "set-dynamic-header",
		Success: true,
	}
}

func handleSetDynamicParam(cmd Command) Result {
	dynamicParams[cmd.Name] = &DynamicValue{
		Type:    cmd.ValueType,
		Counter: 0,
	}
	return Result{
		Type:    "set-dynamic-param",
		Success: true,
	}
}

func handleClearDynamic(cmd Command) Result {
	dynamicHeaders = make(map[string]*DynamicValue)
	dynamicParams = make(map[string]*DynamicValue)
	return Result{
		Type:    "clear-dynamic",
		Success: true,
	}
}

func handleValidate(cmd Command) Result {
	if cmd.Target == nil {
		return sendError("validate", "PARSE_ERROR", "missing target")
	}

	target := cmd.Target

	switch target.Target {
	case "retry-options":
		// Go client doesn't have a separate RetryOptions class
		return sendError("validate", "NOT_SUPPORTED", "Go client does not have RetryOptions class")

	case "idempotent-producer":
		// Test IdempotentProducer validation
		producerID := target.ProducerID
		if producerID == "" {
			producerID = "test-producer"
		}

		config := durablestreams.IdempotentProducerConfig{}
		if target.Epoch != nil {
			config.Epoch = *target.Epoch
		}
		if target.MaxBatchBytes != nil {
			config.MaxBatchBytes = *target.MaxBatchBytes
		}

		_, err := client.IdempotentProducer(serverURL+"/test-validate", producerID, config)
		if err != nil {
			return Result{
				Type:        "error",
				Success:     false,
				CommandType: "validate",
				ErrorCode:   "INVALID_ARGUMENT",
				Message:     err.Error(),
			}
		}

		return Result{
			Type:    "validate",
			Success: true,
		}

	default:
		return sendError("validate", "NOT_SUPPORTED", fmt.Sprintf("unknown validation target: %s", target.Target))
	}
}

func handleIdempotentAppend(cmd Command) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	url := serverURL + cmd.Path

	// Get content-type from cache or use default
	contentType := streamContentTypes[cmd.Path]
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	producer, err := client.IdempotentProducer(url, cmd.ProducerID, durablestreams.IdempotentProducerConfig{
		Epoch:       cmd.Epoch,
		AutoClaim:   cmd.AutoClaim,
		MaxInFlight: 1,
		LingerMs:    0, // Send immediately for testing
		ContentType: contentType,
	})
	if err != nil {
		return errorResult("idempotent-append", err)
	}
	defer producer.Close()

	// For JSON streams, parse the string data into a native object
	// (IdempotentProducer now expects native objects for JSON streams)
	var data any
	if normalizeContentType(contentType) == "application/json" {
		if err := json.Unmarshal([]byte(cmd.Data), &data); err != nil {
			return sendError("idempotent-append", "PARSE_ERROR", fmt.Sprintf("invalid JSON: %v", err))
		}
	} else {
		data = []byte(cmd.Data)
	}

	// Append returns immediately (fire-and-forget)
	if err := producer.Append(data); err != nil {
		return errorResult("idempotent-append", err)
	}

	// Flush to actually send and wait for result
	if err := producer.Flush(ctx); err != nil {
		return errorResult("idempotent-append", err)
	}

	// Note: With fire-and-forget API we don't get per-message results
	// Tests verify data via read, not append response
	return Result{
		Type:    "idempotent-append",
		Success: true,
		Status:  200,
	}
}

func handleIdempotentAppendBatch(cmd Command) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	url := serverURL + cmd.Path

	// Get content-type from cache or use default
	contentType := streamContentTypes[cmd.Path]
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Use provided maxInFlight or default to 1 for compatibility
	maxInFlight := 1
	if cmd.MaxInFlight > 0 {
		maxInFlight = cmd.MaxInFlight
	}

	// When testing concurrency (maxInFlight > 1), use small batches to force
	// multiple concurrent requests. Otherwise batch all items together.
	testingConcurrency := maxInFlight > 1
	lingerMs := 1000
	maxBatchBytes := 1024 * 1024
	if testingConcurrency {
		lingerMs = 0
		maxBatchBytes = 1
	}

	producer, err := client.IdempotentProducer(url, cmd.ProducerID, durablestreams.IdempotentProducerConfig{
		Epoch:         cmd.Epoch,
		AutoClaim:     cmd.AutoClaim,
		MaxInFlight:   maxInFlight,
		LingerMs:      lingerMs,
		MaxBatchBytes: maxBatchBytes,
		ContentType:   contentType,
	})
	if err != nil {
		return errorResult("idempotent-append-batch", err)
	}
	defer producer.Close()

	// For JSON streams, parse the string items into native objects
	// (IdempotentProducer now expects native objects for JSON streams)
	isJSON := normalizeContentType(contentType) == "application/json"

	// Queue all items using Append (non-blocking, no channels)
	for _, item := range cmd.Items {
		var data any
		if isJSON {
			var parsed any
			if err := json.Unmarshal([]byte(item), &parsed); err != nil {
				return sendError("idempotent-append-batch", "PARSE_ERROR", fmt.Sprintf("invalid JSON: %v", err))
			}
			data = parsed
		} else {
			data = []byte(item)
		}

		if err := producer.Append(data); err != nil {
			return errorResult("idempotent-append-batch", err)
		}
	}

	// Flush to send the batch
	if err := producer.Flush(ctx); err != nil {
		return errorResult("idempotent-append-batch", err)
	}

	return Result{
		Type:    "idempotent-append-batch",
		Success: true,
		Status:  200,
	}
}

func errorResult(cmdType string, err error) Result {
	var streamErr *durablestreams.StreamError
	if errors.As(err, &streamErr) {
		code := mapErrorCode(streamErr)
		return Result{
			Type:        "error",
			Success:     false,
			CommandType: cmdType,
			Status:      streamErr.StatusCode,
			ErrorCode:   code,
			Message:     err.Error(),
		}
	}

	return Result{
		Type:        "error",
		Success:     false,
		CommandType: cmdType,
		ErrorCode:   "INTERNAL_ERROR",
		Message:     err.Error(),
	}
}

func sendError(cmdType, code, message string) Result {
	return Result{
		Type:        "error",
		Success:     false,
		CommandType: cmdType,
		ErrorCode:   code,
		Message:     message,
	}
}

func mapErrorCode(err *durablestreams.StreamError) string {
	if errors.Is(err.Err, durablestreams.ErrStreamNotFound) {
		return "NOT_FOUND"
	}
	if errors.Is(err.Err, durablestreams.ErrStreamExists) {
		return "CONFLICT"
	}
	if errors.Is(err.Err, durablestreams.ErrSeqConflict) {
		return "SEQUENCE_CONFLICT"
	}
	if errors.Is(err.Err, durablestreams.ErrOffsetGone) {
		return "INVALID_OFFSET"
	}
	if errors.Is(err.Err, durablestreams.ErrRateLimited) {
		return "UNEXPECTED_STATUS"
	}

	switch err.StatusCode {
	case 400:
		return "INVALID_OFFSET"
	case 404:
		return "NOT_FOUND"
	case 409:
		return "CONFLICT"
	case 410:
		return "INVALID_OFFSET"
	case 429:
		return "UNEXPECTED_STATUS"
	default:
		return "UNEXPECTED_STATUS"
	}
}

func handleBenchmark(cmd Command) Result {
	if cmd.Operation == nil {
		return sendError("benchmark", "PARSE_ERROR", "missing operation")
	}

	op := cmd.Operation
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var durationNs int64
	var metrics *BenchmarkMetrics

	switch op.Op {
	case "append":
		durationNs = benchmarkAppend(ctx, op.Path, op.Size)

	case "read":
		durationNs = benchmarkRead(ctx, op.Path, op.Offset)

	case "roundtrip":
		durationNs = benchmarkRoundtrip(ctx, op.Path, op.Size, op.Live, op.ContentType)

	case "create":
		durationNs = benchmarkCreate(ctx, op.Path, op.ContentType)

	case "throughput_append":
		durationNs, metrics = benchmarkThroughputAppend(ctx, op.Path, op.Count, op.Size, op.Concurrency)

	case "throughput_read":
		durationNs, metrics = benchmarkThroughputRead(ctx, op.Path)

	default:
		return sendError("benchmark", "NOT_SUPPORTED", fmt.Sprintf("unknown benchmark op: %s", op.Op))
	}

	return Result{
		Type:        "benchmark",
		Success:     true,
		IterationID: cmd.IterationID,
		DurationNs:  strconv.FormatInt(durationNs, 10),
		Metrics:     metrics,
	}
}

func benchmarkAppend(ctx context.Context, path string, size int) int64 {
	stream := client.Stream(path)
	if ct, ok := streamContentTypes[path]; ok {
		stream.SetContentType(ct)
	}

	data := make([]byte, size)
	rand.Read(data)

	start := time.Now()
	_, _ = stream.Append(ctx, data)
	return time.Since(start).Nanoseconds()
}

func benchmarkRead(ctx context.Context, path string, offset string) int64 {
	stream := client.Stream(path)

	opts := []durablestreams.ReadOption{}
	if offset != "" {
		opts = append(opts, durablestreams.WithOffset(durablestreams.Offset(offset)))
	}

	start := time.Now()
	it := stream.Read(ctx, opts...)
	defer it.Close()
	_, _ = it.Next()
	return time.Since(start).Nanoseconds()
}

func benchmarkRoundtrip(ctx context.Context, path string, size int, live string, contentType string) int64 {
	stream := client.Stream(path)
	if contentType != "" {
		stream.SetContentType(contentType)
	} else if ct, ok := streamContentTypes[path]; ok {
		stream.SetContentType(ct)
	}

	data := make([]byte, size)
	rand.Read(data)

	var liveMode durablestreams.LiveMode
	switch live {
	case "long-poll":
		liveMode = durablestreams.LiveModeLongPoll
	case "sse":
		liveMode = durablestreams.LiveModeSSE
	default:
		liveMode = durablestreams.LiveModeLongPoll
	}

	start := time.Now()

	// Append
	result, err := stream.Append(ctx, data)
	if err != nil {
		return time.Since(start).Nanoseconds()
	}

	// Read back using the offset before our append
	// We need to read from the position before our data
	meta, err := stream.Head(ctx)
	if err != nil {
		return time.Since(start).Nanoseconds()
	}

	// Calculate the offset before our append
	nextOffsetInt, _ := strconv.Atoi(string(result.NextOffset))
	prevOffset := strconv.Itoa(nextOffsetInt - size)

	it := stream.Read(ctx,
		durablestreams.WithOffset(durablestreams.Offset(prevOffset)),
		durablestreams.WithLive(liveMode),
	)
	defer it.Close()
	_, _ = it.Next()
	_ = meta // silence unused warning

	return time.Since(start).Nanoseconds()
}

func benchmarkCreate(ctx context.Context, path string, contentType string) int64 {
	stream := client.Stream(path)

	ct := contentType
	if ct == "" {
		ct = "application/octet-stream"
	}

	start := time.Now()
	_ = stream.Create(ctx, durablestreams.WithContentType(ct))
	streamContentTypes[path] = ct
	return time.Since(start).Nanoseconds()
}

func benchmarkThroughputAppend(ctx context.Context, path string, count, size, concurrency int) (int64, *BenchmarkMetrics) {
	url := serverURL + path
	ct := streamContentTypes[path]
	if ct == "" {
		ct = "application/octet-stream"
	}

	// Use IdempotentProducer for automatic batching and pipelining
	// Append is fire-and-forget - no goroutines needed
	producer, err := client.IdempotentProducer(url, "bench-producer", durablestreams.IdempotentProducerConfig{
		LingerMs:    0, // Batch by size, not time
		ContentType: ct,
	})
	if err != nil {
		return 0, nil
	}
	defer producer.Close()

	// Pre-generate payload (reuse same data for speed)
	payload := make([]byte, size)
	rand.Read(payload)

	start := time.Now()

	// Fire-and-forget: Append returns immediately, producer batches in background
	for i := 0; i < count; i++ {
		_ = producer.Append(payload)
	}

	// Wait for all batches to complete
	_ = producer.Flush(ctx)
	elapsed := time.Since(start)

	totalBytes := count * size
	opsPerSec := float64(count) / elapsed.Seconds()
	bytesPerSec := float64(totalBytes) / elapsed.Seconds()

	return elapsed.Nanoseconds(), &BenchmarkMetrics{
		BytesTransferred:  totalBytes,
		MessagesProcessed: count,
		OpsPerSecond:      opsPerSec,
		BytesPerSecond:    bytesPerSec,
	}
}

func benchmarkThroughputRead(ctx context.Context, path string) (int64, *BenchmarkMetrics) {
	stream := client.Stream(path)
	stream.SetContentType("application/json")

	start := time.Now()

	// Use JSON iterator to parse and count messages
	it := durablestreams.ReadJSON[map[string]any](ctx, stream, durablestreams.WithOffset(durablestreams.StartOffset))
	defer it.Close()

	var totalBytes int
	var count int

	for {
		batch, err := it.Next()
		if errors.Is(err, durablestreams.Done) {
			break
		}
		if err != nil {
			break
		}
		// Count items in batch and estimate bytes
		for _, item := range batch.Items {
			count++
			// Rough byte estimate
			data, _ := json.Marshal(item)
			totalBytes += len(data)
		}
		if batch.UpToDate {
			break
		}
	}

	elapsed := time.Since(start)
	bytesPerSec := float64(totalBytes) / elapsed.Seconds()

	return elapsed.Nanoseconds(), &BenchmarkMetrics{
		BytesTransferred:  totalBytes,
		MessagesProcessed: count,
		BytesPerSecond:    bytesPerSec,
	}
}

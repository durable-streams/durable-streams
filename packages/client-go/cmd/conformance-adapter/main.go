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
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
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
	// Open-loop fields
	InnerOp        string `json:"innerOp,omitempty"`
	TargetRps      int    `json:"targetRps,omitempty"`
	DurationMs     int    `json:"durationMs,omitempty"`
	MaxConcurrency int    `json:"maxConcurrency,omitempty"`
	WarmupMs       int    `json:"warmupMs,omitempty"`
	DrainTimeoutMs int    `json:"drainTimeoutMs,omitempty"`
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
	// Benchmark fields
	IterationID string            `json:"iterationId,omitempty"`
	DurationNs  string            `json:"durationNs,omitempty"`
	Metrics     *BenchmarkMetrics `json:"metrics,omitempty"`
	OpenLoop    *OpenLoopMetrics  `json:"openLoop,omitempty"`
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

// OpenLoopMetrics contains open-loop benchmark results
type OpenLoopMetrics struct {
	TargetRps      float64            `json:"targetRps"`
	AchievedRps    float64            `json:"achievedRps"`
	OfferedCount   int                `json:"offeredCount"`
	CompletedCount int                `json:"completedCount"`
	FailedCount    int                `json:"failedCount"`
	SuccessRate    float64            `json:"successRate"`
	TotalLatency   *LatencyPercentiles `json:"totalLatency"`
	QueueLatency   *LatencyPercentiles `json:"queueLatency"`
	ServiceLatency *LatencyPercentiles `json:"serviceLatency"`
}

// LatencyPercentiles contains latency percentiles in milliseconds
type LatencyPercentiles struct {
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Mean   float64 `json:"mean"`
	Median float64 `json:"median"`
	P75    float64 `json:"p75"`
	P90    float64 `json:"p90"`
	P95    float64 `json:"p95"`
	P99    float64 `json:"p99"`
	P999   float64 `json:"p999"`
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
				break
			}
			return errorResult("read", err)
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
		Status:   200,
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

	case "open_loop":
		openLoop := benchmarkOpenLoop(ctx, op)
		return Result{
			Type:        "benchmark",
			Success:     true,
			IterationID: cmd.IterationID,
			DurationNs:  "0",
			OpenLoop:    openLoop,
		}

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
	stream := client.Stream(path)
	if ct, ok := streamContentTypes[path]; ok {
		stream.SetContentType(ct)
	}

	// Use BatchedStream for automatic batching - this is what makes Go competitive
	batched := durablestreams.NewBatchedStream(stream)
	defer batched.Close()

	// Pre-generate all data
	allData := make([][]byte, count)
	for i := range allData {
		allData[i] = make([]byte, size)
		rand.Read(allData[i])
	}

	// Submit all appends concurrently using goroutines
	var wg sync.WaitGroup

	start := time.Now()

	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(data []byte) {
			defer wg.Done()
			_, _ = batched.Append(ctx, data)
		}(allData[i])
	}

	wg.Wait()
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

// openLoopSample records timing for one request
type openLoopSample struct {
	scheduledAt time.Time
	startedAt   time.Time
	completedAt time.Time
	failed      bool
}

func benchmarkOpenLoop(ctx context.Context, op *BenchmarkOperation) *OpenLoopMetrics {
	targetRps := op.TargetRps
	durationMs := op.DurationMs
	maxConcurrency := op.MaxConcurrency
	warmupMs := op.WarmupMs
	drainTimeoutMs := op.DrainTimeoutMs

	if maxConcurrency == 0 {
		maxConcurrency = 1000
	}
	if drainTimeoutMs == 0 {
		drainTimeoutMs = 10000 // 10 second default
	}

	// Create a cancellable context for all operations
	// This lets us abort in-flight requests when drain times out
	opCtx, cancelOps := context.WithCancel(ctx)
	defer cancelOps()

	periodNs := int64(1_000_000_000 / targetRps)
	totalDurationNs := int64(durationMs) * 1_000_000
	warmupNs := int64(warmupMs) * 1_000_000

	// Pre-generate payload for append/roundtrip operations
	var payload []byte
	if op.InnerOp == "append" || op.InnerOp == "roundtrip" {
		payload = make([]byte, op.Size)
		rand.Read(payload)
	}

	// Create the stream for append operations
	stream := client.Stream(op.Path)
	if ct, ok := streamContentTypes[op.Path]; ok {
		stream.SetContentType(ct)
	}

	// Create operation function based on inner op
	var opFn func(context.Context) error
	switch op.InnerOp {
	case "append":
		opFn = func(ctx context.Context) error {
			_, err := stream.Append(ctx, payload)
			return err
		}
	case "read":
		opFn = func(ctx context.Context) error {
			it := stream.Read(ctx, durablestreams.WithOffset(durablestreams.StartOffset))
			defer it.Close()
			_, err := it.Next()
			return err
		}
	case "roundtrip":
		liveMode := durablestreams.LiveModeLongPoll
		if op.Live == "sse" {
			liveMode = durablestreams.LiveModeSSE
		}
		var rtCounter int64
		opFn = func(ctx context.Context) error {
			// Each roundtrip uses a unique stream to avoid conflicts
			rtPath := fmt.Sprintf("%s/rt-%d", op.Path, atomic.AddInt64(&rtCounter, 1))
			rtStream := client.Stream(rtPath)
			rtStream.SetContentType("application/octet-stream")

			// Create stream
			if err := rtStream.Create(ctx, durablestreams.WithContentType("application/octet-stream")); err != nil {
				return err
			}

			// Start reading before appending
			readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()

			done := make(chan error, 1)
			go func() {
				it := rtStream.Read(readCtx, durablestreams.WithLive(liveMode))
				defer it.Close()
				_, err := it.Next()
				done <- err
			}()

			// Brief delay to ensure reader is ready
			time.Sleep(time.Millisecond)

			// Append
			if _, err := rtStream.Append(ctx, payload); err != nil {
				return err
			}

			// Wait for read to complete
			return <-done
		}
	default:
		opFn = func(ctx context.Context) error {
			return nil
		}
	}

	// Collect samples
	var samples []openLoopSample
	var samplesMu sync.Mutex

	// Semaphore for concurrency limiting
	sem := make(chan struct{}, maxConcurrency)

	// Start scheduling requests
	startTime := time.Now()
	var seq int64
	var inFlight sync.WaitGroup

	for {
		scheduledNs := seq * periodNs
		scheduledAt := startTime.Add(time.Duration(scheduledNs))

		// Check if we've exceeded duration
		if scheduledNs >= totalDurationNs+warmupNs {
			break
		}

		// Wait until scheduled time
		now := time.Now()
		if scheduledAt.After(now) {
			time.Sleep(scheduledAt.Sub(now))
		}

		// Acquire semaphore slot
		sem <- struct{}{}

		inFlight.Add(1)
		go func(sched time.Time, seqNum int64, isWarmup bool) {
			defer inFlight.Done()
			defer func() { <-sem }()

			started := time.Now()
			err := opFn(opCtx)
			completed := time.Now()

			// Skip warmup samples
			if isWarmup {
				return
			}

			samplesMu.Lock()
			samples = append(samples, openLoopSample{
				scheduledAt: sched,
				startedAt:   started,
				completedAt: completed,
				failed:      err != nil,
			})
			samplesMu.Unlock()
		}(scheduledAt, seq, scheduledNs < warmupNs)

		seq++
	}

	// Wait for in-flight requests to complete, but with a timeout
	// This prevents indefinite blocking when the system is saturated
	done := make(chan struct{})
	go func() {
		inFlight.Wait()
		close(done)
	}()

	select {
	case <-done:
		// All requests completed
	case <-time.After(time.Duration(drainTimeoutMs) * time.Millisecond):
		// Timeout - cancel all in-flight operations to close their connections
		cancelOps()
	}

	// Calculate metrics
	return calculateOpenLoopMetrics(samples, float64(targetRps), durationMs)
}

func calculateOpenLoopMetrics(samples []openLoopSample, targetRps float64, durationMs int) *OpenLoopMetrics {
	if len(samples) == 0 {
		return &OpenLoopMetrics{
			TargetRps:      targetRps,
			TotalLatency:   &LatencyPercentiles{},
			QueueLatency:   &LatencyPercentiles{},
			ServiceLatency: &LatencyPercentiles{},
		}
	}

	var completedCount, failedCount int
	var queueLatencies, serviceLatencies, totalLatencies []float64

	for _, s := range samples {
		if s.failed {
			failedCount++
			continue
		}
		completedCount++

		queueMs := float64(s.startedAt.Sub(s.scheduledAt).Nanoseconds()) / 1_000_000
		serviceMs := float64(s.completedAt.Sub(s.startedAt).Nanoseconds()) / 1_000_000
		totalMs := float64(s.completedAt.Sub(s.scheduledAt).Nanoseconds()) / 1_000_000

		queueLatencies = append(queueLatencies, queueMs)
		serviceLatencies = append(serviceLatencies, serviceMs)
		totalLatencies = append(totalLatencies, totalMs)
	}

	offeredCount := len(samples)
	successRate := float64(completedCount) / float64(offeredCount)
	achievedRps := float64(completedCount) / (float64(durationMs) / 1000)

	return &OpenLoopMetrics{
		TargetRps:      targetRps,
		AchievedRps:    achievedRps,
		OfferedCount:   offeredCount,
		CompletedCount: completedCount,
		FailedCount:    failedCount,
		SuccessRate:    successRate,
		TotalLatency:   calculatePercentiles(totalLatencies),
		QueueLatency:   calculatePercentiles(queueLatencies),
		ServiceLatency: calculatePercentiles(serviceLatencies),
	}
}

func calculatePercentiles(values []float64) *LatencyPercentiles {
	if len(values) == 0 {
		return &LatencyPercentiles{}
	}

	sorted := make([]float64, len(values))
	copy(sorted, values)
	sort.Float64s(sorted)

	n := len(sorted)
	var sum float64
	for _, v := range sorted {
		sum += v
	}

	return &LatencyPercentiles{
		Min:    sorted[0],
		Max:    sorted[n-1],
		Mean:   sum / float64(n),
		Median: percentile(sorted, 0.5),
		P75:    percentile(sorted, 0.75),
		P90:    percentile(sorted, 0.90),
		P95:    percentile(sorted, 0.95),
		P99:    percentile(sorted, 0.99),
		P999:   percentile(sorted, 0.999),
	}
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(float64(len(sorted)-1) * p)
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

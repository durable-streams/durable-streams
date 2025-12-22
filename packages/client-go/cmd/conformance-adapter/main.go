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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
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
	Offset           string `json:"offset,omitempty"`
	Live             any    `json:"live,omitempty"` // false | "long-poll" | "sse"
	MaxChunks        int    `json:"maxChunks,omitempty"`
	WaitForUpToDate  bool   `json:"waitForUpToDate,omitempty"`
	// Headers
	Headers map[string]string `json:"headers,omitempty"`
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
}

type Features struct {
	Batching  bool `json:"batching"`
	SSE       bool `json:"sse"`
	LongPoll  bool `json:"longPoll"`
	Streaming bool `json:"streaming"`
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
	case "shutdown":
		return Result{Type: "shutdown", Success: true}
	default:
		return sendError(cmd.Type, "NOT_SUPPORTED", fmt.Sprintf("unknown command type: %s", cmd.Type))
	}
}

func handleInit(cmd Command) Result {
	serverURL = cmd.ServerURL
	streamContentTypes = make(map[string]string)
	client = durablestreams.NewClient(
		durablestreams.WithBaseURL(serverURL),
	)

	return Result{
		Type:          "init",
		Success:       true,
		ClientName:    "durable-streams-go",
		ClientVersion: clientVersion,
		Features: &Features{
			Batching:  true,
			SSE:       true,
			LongPoll:  true,
			Streaming: true,
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

	var opts []durablestreams.AppendOption
	if cmd.Seq > 0 {
		opts = append(opts, durablestreams.WithSeq(strconv.Itoa(cmd.Seq)))
	}
	if len(cmd.Headers) > 0 {
		opts = append(opts, durablestreams.WithAppendHeaders(cmd.Headers))
	}

	result, err := stream.Append(ctx, data, opts...)
	if err != nil {
		return errorResult("append", err)
	}

	return Result{
		Type:    "append",
		Success: true,
		Status:  200,
		Offset:  string(result.NextOffset),
	}
}

func handleRead(cmd Command) Result {
	timeoutMs := cmd.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 5000
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	stream := client.Stream(cmd.Path)

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
	if len(cmd.Headers) > 0 {
		opts = append(opts, durablestreams.WithReadHeaders(cmd.Headers))
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

	return Result{
		Type:     "read",
		Success:  true,
		Status:   200,
		Chunks:   chunks,
		Offset:   finalOffset,
		UpToDate: upToDate,
	}
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

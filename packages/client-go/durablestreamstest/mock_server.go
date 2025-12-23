// Package durablestreamstest provides testing utilities for durable streams clients.
//
// The package includes an in-memory mock server that implements the Durable Streams
// protocol, useful for unit testing without network dependencies.
//
// Example:
//
//	func TestMyCode(t *testing.T) {
//	    // Create mock server
//	    server := durablestreamstest.NewMockServer()
//	    defer server.Close()
//
//	    // Create client pointing to mock server
//	    client := durablestreams.NewClient(
//	        durablestreams.WithHTTPClient(server.HTTPClient()),
//	    )
//
//	    // Use client normally
//	    stream := client.Stream(server.URL() + "/my-stream")
//	    // ...
//	}
package durablestreamstest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MockServer is an in-memory implementation of a Durable Streams server.
// It's useful for testing client code without network dependencies.
type MockServer struct {
	server  *httptest.Server
	streams map[string]*mockStream
	mu      sync.RWMutex
}

// mockStream represents an in-memory stream.
type mockStream struct {
	contentType string
	data        []byte
	offset      int
	seq         int
	createdAt   time.Time
	ttl         *time.Duration
	expiresAt   *time.Time
}

// NewMockServer creates a new mock Durable Streams server.
func NewMockServer() *MockServer {
	ms := &MockServer{
		streams: make(map[string]*mockStream),
	}

	ms.server = httptest.NewServer(http.HandlerFunc(ms.handleRequest))
	return ms
}

// URL returns the base URL of the mock server.
func (ms *MockServer) URL() string {
	return ms.server.URL
}

// HTTPClient returns an HTTP client configured to use the mock server.
func (ms *MockServer) HTTPClient() *http.Client {
	return ms.server.Client()
}

// Close shuts down the mock server.
func (ms *MockServer) Close() {
	ms.server.Close()
}

// Reset clears all streams from the server.
func (ms *MockServer) Reset() {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	ms.streams = make(map[string]*mockStream)
}

// GetStreamData returns the raw data for a stream.
// Useful for assertions in tests.
func (ms *MockServer) GetStreamData(path string) ([]byte, bool) {
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	stream, ok := ms.streams[path]
	if !ok {
		return nil, false
	}
	return stream.data, true
}

// handleRequest routes HTTP requests to the appropriate handler.
func (ms *MockServer) handleRequest(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	switch r.Method {
	case http.MethodPut:
		ms.handleCreate(w, r, path)
	case http.MethodPost:
		ms.handleAppend(w, r, path)
	case http.MethodGet:
		ms.handleRead(w, r, path)
	case http.MethodHead:
		ms.handleHead(w, r, path)
	case http.MethodDelete:
		ms.handleDelete(w, r, path)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleCreate handles PUT requests to create a stream.
func (ms *MockServer) handleCreate(w http.ResponseWriter, r *http.Request, path string) {
	ms.mu.Lock()
	defer ms.mu.Unlock()

	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Check if stream already exists
	if existing, ok := ms.streams[path]; ok {
		// Idempotent create - check content type matches
		if existing.contentType != contentType {
			http.Error(w, "Stream exists with different content type", http.StatusConflict)
			return
		}
		w.Header().Set("Stream-Next-Offset", strconv.Itoa(existing.offset))
		w.WriteHeader(http.StatusOK)
		return
	}

	// Read initial data if provided
	var initialData []byte
	if r.Body != nil {
		var err error
		initialData, err = io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "Failed to read body", http.StatusBadRequest)
			return
		}
	}

	stream := &mockStream{
		contentType: contentType,
		data:        initialData,
		offset:      len(initialData),
		createdAt:   time.Now(),
	}

	// Parse TTL if provided
	if ttlStr := r.Header.Get("Stream-TTL"); ttlStr != "" {
		if secs, err := strconv.ParseInt(ttlStr, 10, 64); err == nil {
			ttl := time.Duration(secs) * time.Second
			stream.ttl = &ttl
		}
	}

	// Parse expires-at if provided
	if expiresStr := r.Header.Get("Stream-Expires-At"); expiresStr != "" {
		if t, err := time.Parse(time.RFC3339, expiresStr); err == nil {
			stream.expiresAt = &t
		}
	}

	ms.streams[path] = stream

	w.Header().Set("Stream-Next-Offset", strconv.Itoa(stream.offset))
	w.WriteHeader(http.StatusCreated)
}

// handleAppend handles POST requests to append data.
func (ms *MockServer) handleAppend(w http.ResponseWriter, r *http.Request, path string) {
	ms.mu.Lock()
	defer ms.mu.Unlock()

	stream, ok := ms.streams[path]
	if !ok {
		http.Error(w, "Stream not found", http.StatusNotFound)
		return
	}

	// Read data
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}

	// Check sequence number if provided
	if seqStr := r.Header.Get("Stream-Seq"); seqStr != "" {
		seq, err := strconv.Atoi(seqStr)
		if err != nil {
			http.Error(w, "Invalid sequence number", http.StatusBadRequest)
			return
		}
		if seq <= stream.seq {
			http.Error(w, "Sequence conflict", http.StatusConflict)
			return
		}
		stream.seq = seq
	}

	// Append data
	stream.data = append(stream.data, data...)
	stream.offset = len(stream.data)

	w.Header().Set("Stream-Next-Offset", strconv.Itoa(stream.offset))
	w.WriteHeader(http.StatusOK)
}

// handleRead handles GET requests to read data.
func (ms *MockServer) handleRead(w http.ResponseWriter, r *http.Request, path string) {
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	stream, ok := ms.streams[path]
	if !ok {
		http.Error(w, "Stream not found", http.StatusNotFound)
		return
	}

	// Parse offset
	offset := 0
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		if offsetStr == "-1" {
			offset = 0
		} else {
			var err error
			offset, err = strconv.Atoi(offsetStr)
			if err != nil {
				http.Error(w, "Invalid offset", http.StatusBadRequest)
				return
			}
		}
	}

	// Check if offset is valid
	if offset > len(stream.data) {
		http.Error(w, "Offset gone", http.StatusGone)
		return
	}

	// Get live mode
	liveMode := r.URL.Query().Get("live")

	// Handle SSE mode
	if liveMode == "sse" {
		ms.handleSSERead(w, r, stream, offset)
		return
	}

	// Regular read
	data := stream.data[offset:]

	w.Header().Set("Content-Type", stream.contentType)
	w.Header().Set("Stream-Next-Offset", strconv.Itoa(len(stream.data)))
	w.Header().Set("Stream-Up-To-Date", "true")
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

// handleSSERead handles SSE streaming reads.
func (ms *MockServer) handleSSERead(w http.ResponseWriter, r *http.Request, stream *mockStream, offset int) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}

	// Send existing data
	if offset < len(stream.data) {
		data := stream.data[offset:]
		fmt.Fprintf(w, "data: %s\n\n", string(data))
		flusher.Flush()
	}

	// Send control event
	fmt.Fprintf(w, "event: control\ndata: {\"streamNextOffset\":\"%d\",\"upToDate\":true}\n\n",
		len(stream.data))
	flusher.Flush()
}

// handleHead handles HEAD requests for stream metadata.
func (ms *MockServer) handleHead(w http.ResponseWriter, r *http.Request, path string) {
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	stream, ok := ms.streams[path]
	if !ok {
		http.Error(w, "Stream not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", stream.contentType)
	w.Header().Set("Stream-Next-Offset", strconv.Itoa(stream.offset))

	if stream.ttl != nil {
		remaining := *stream.ttl - time.Since(stream.createdAt)
		if remaining > 0 {
			w.Header().Set("Stream-TTL", strconv.FormatInt(int64(remaining.Seconds()), 10))
		}
	}
	if stream.expiresAt != nil {
		w.Header().Set("Stream-Expires-At", stream.expiresAt.Format(time.RFC3339))
	}

	w.WriteHeader(http.StatusOK)
}

// handleDelete handles DELETE requests.
func (ms *MockServer) handleDelete(w http.ResponseWriter, r *http.Request, path string) {
	ms.mu.Lock()
	defer ms.mu.Unlock()

	if _, ok := ms.streams[path]; !ok {
		http.Error(w, "Stream not found", http.StatusNotFound)
		return
	}

	delete(ms.streams, path)
	w.WriteHeader(http.StatusOK)
}

// MockTransport is an http.RoundTripper that records requests and returns
// configured responses. Useful for testing client behavior without a server.
type MockTransport struct {
	mu        sync.Mutex
	requests  []*http.Request
	responses []*http.Response
	errors    []error
	index     int
}

// NewMockTransport creates a new MockTransport.
func NewMockTransport() *MockTransport {
	return &MockTransport{
		requests:  make([]*http.Request, 0),
		responses: make([]*http.Response, 0),
		errors:    make([]error, 0),
	}
}

// AddResponse adds a response to be returned by the next matching request.
func (mt *MockTransport) AddResponse(resp *http.Response, err error) {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	mt.responses = append(mt.responses, resp)
	mt.errors = append(mt.errors, err)
}

// AddJSONResponse is a helper to add a JSON response.
func (mt *MockTransport) AddJSONResponse(status int, body any, headers map[string]string) {
	data, _ := json.Marshal(body)
	resp := &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(string(data))),
	}
	resp.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		resp.Header.Set(k, v)
	}
	mt.AddResponse(resp, nil)
}

// Requests returns all recorded requests.
func (mt *MockTransport) Requests() []*http.Request {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	return mt.requests
}

// RoundTrip implements http.RoundTripper.
func (mt *MockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	mt.mu.Lock()
	defer mt.mu.Unlock()

	mt.requests = append(mt.requests, req)

	if mt.index >= len(mt.responses) {
		return nil, fmt.Errorf("no more mock responses configured")
	}

	resp := mt.responses[mt.index]
	err := mt.errors[mt.index]
	mt.index++

	return resp, err
}

// Reset clears all recorded requests and responses.
func (mt *MockTransport) Reset() {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	mt.requests = make([]*http.Request, 0)
	mt.responses = make([]*http.Response, 0)
	mt.errors = make([]error, 0)
	mt.index = 0
}

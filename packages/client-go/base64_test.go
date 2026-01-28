package durablestreams

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestBase64DecodeSSEData tests that base64-encoded SSE data events are correctly decoded
func TestBase64DecodeSSEData(t *testing.T) {
	tests := []struct {
		name     string
		input    []byte
		wantData []byte
	}{
		{
			name:     "simple text",
			input:    []byte("Hello, World!"),
			wantData: []byte("Hello, World!"),
		},
		{
			name:     "empty payload",
			input:    []byte{},
			wantData: []byte{},
		},
		{
			name:     "binary with null byte",
			input:    []byte{0x00, 0x01, 0x02},
			wantData: []byte{0x00, 0x01, 0x02},
		},
		{
			name:     "binary with 0xFF",
			input:    []byte{0xFF, 0xFE, 0xFD},
			wantData: []byte{0xFF, 0xFE, 0xFD},
		},
		{
			name:     "all byte values",
			input:    makeAllBytes(),
			wantData: makeAllBytes(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Encode the input as base64 for the SSE event
			encoded := base64.StdEncoding.EncodeToString(tt.input)

			// Create SSE response with base64-encoded data
			sseData := "event: data\ndata: " + encoded + "\n\nevent: control\ndata: {\"streamNextOffset\":\"100\"}\n\n"

			// Create test server
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Verify encoding query param is set
				if r.URL.Query().Get("encoding") != "base64" {
					t.Error("expected encoding=base64 query param")
				}

				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(sseData))
			}))
			defer server.Close()

			// Create client and stream
			client := NewClient(WithBaseURL(server.URL))
			stream := client.Stream("/test")

			// Read with SSE and base64 encoding
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			it := stream.Read(ctx,
				WithLive(LiveModeSSE),
				WithEncoding("base64"),
			)
			defer it.Close()

			chunk, err := it.Next()
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if !bytes.Equal(chunk.Data, tt.wantData) {
				t.Errorf("got data %v, want %v", chunk.Data, tt.wantData)
			}
		})
	}
}

// TestBase64URLBuilding tests that encoding query param is added to SSE URLs
func TestBase64URLBuilding(t *testing.T) {
	tests := []struct {
		name        string
		live        LiveMode
		encoding    string
		wantEncoded bool
	}{
		{
			name:        "SSE with base64 encoding",
			live:        LiveModeSSE,
			encoding:    "base64",
			wantEncoded: true,
		},
		{
			name:        "SSE without encoding",
			live:        LiveModeSSE,
			encoding:    "",
			wantEncoded: false,
		},
		{
			name:        "long-poll with encoding (should not add param)",
			live:        LiveModeLongPoll,
			encoding:    "base64",
			wantEncoded: false,
		},
		{
			name:        "no live mode with encoding (should not add param)",
			live:        LiveModeNone,
			encoding:    "base64",
			wantEncoded: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := NewClient()
			stream := client.Stream("http://example.com/test")

			url := stream.buildReadURL(StartOffset, tt.live, "", tt.encoding)

			hasEncoding := strings.Contains(url, "encoding=base64")
			if hasEncoding != tt.wantEncoded {
				t.Errorf("URL %q: hasEncoding=%v, want %v", url, hasEncoding, tt.wantEncoded)
			}
		})
	}
}

// TestWithEncodingOption tests the WithEncoding option function
func TestWithEncodingOption(t *testing.T) {
	cfg := &readConfig{}
	opt := WithEncoding("base64")
	opt(cfg)

	if cfg.encoding != "base64" {
		t.Errorf("got encoding %q, want %q", cfg.encoding, "base64")
	}
}

// TestBase64DecodeInvalidData tests error handling for invalid base64 data
func TestBase64DecodeInvalidData(t *testing.T) {
	// Create SSE response with invalid base64 data
	sseData := "event: data\ndata: !!!invalid-base64!!!\n\nevent: control\ndata: {\"streamNextOffset\":\"100\"}\n\n"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(sseData))
	}))
	defer server.Close()

	client := NewClient(WithBaseURL(server.URL))
	stream := client.Stream("/test")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	it := stream.Read(ctx,
		WithLive(LiveModeSSE),
		WithEncoding("base64"),
	)
	defer it.Close()

	_, err := it.Next()
	if err == nil {
		t.Error("expected error for invalid base64 data")
	}
}

// TestBase64MultipleDataEvents tests handling of multiple consecutive SSE data events
func TestBase64MultipleDataEvents(t *testing.T) {
	// Test data: two chunks that should be concatenated
	chunk1 := []byte{0x01, 0x02, 0x03}
	chunk2 := []byte{0x04, 0x05, 0x06}
	expected := append(chunk1, chunk2...)

	encoded1 := base64.StdEncoding.EncodeToString(chunk1)
	encoded2 := base64.StdEncoding.EncodeToString(chunk2)

	// Create SSE response with two data events before control
	sseData := "event: data\ndata: " + encoded1 + "\n\nevent: data\ndata: " + encoded2 + "\n\nevent: control\ndata: {\"streamNextOffset\":\"100\"}\n\n"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(sseData))
	}))
	defer server.Close()

	client := NewClient(WithBaseURL(server.URL))
	stream := client.Stream("/test")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	it := stream.Read(ctx,
		WithLive(LiveModeSSE),
		WithEncoding("base64"),
	)
	defer it.Close()

	chunk, err := it.Next()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !bytes.Equal(chunk.Data, expected) {
		t.Errorf("got data %v, want %v", chunk.Data, expected)
	}
}

// TestSSEWithoutEncodingPassesThroughData tests that SSE without encoding passes data as-is
func TestSSEWithoutEncodingPassesThroughData(t *testing.T) {
	rawData := "Hello, World!"

	// Create SSE response with raw (non-base64) data
	sseData := "event: data\ndata: " + rawData + "\n\nevent: control\ndata: {\"streamNextOffset\":\"100\"}\n\n"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify no encoding query param
		if r.URL.Query().Get("encoding") != "" {
			t.Error("unexpected encoding query param")
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(sseData))
	}))
	defer server.Close()

	client := NewClient(WithBaseURL(server.URL))
	stream := client.Stream("/test")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Read SSE without encoding option
	it := stream.Read(ctx, WithLive(LiveModeSSE))
	defer it.Close()

	chunk, err := it.Next()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if string(chunk.Data) != rawData {
		t.Errorf("got data %q, want %q", string(chunk.Data), rawData)
	}
}

// TestHTTPModeIgnoresEncoding tests that HTTP mode (non-SSE) doesn't add encoding param
func TestHTTPModeIgnoresEncoding(t *testing.T) {
	responseData := []byte("response data")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify no encoding query param in non-SSE mode
		if r.URL.Query().Get("encoding") != "" {
			t.Error("unexpected encoding query param in HTTP mode")
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Stream-Next-Offset", "100")
		w.Header().Set("Stream-Up-To-Date", "true")
		w.WriteHeader(http.StatusOK)
		w.Write(responseData)
	}))
	defer server.Close()

	client := NewClient(WithBaseURL(server.URL))
	stream := client.Stream("/test")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Read with encoding option but no live mode (should be ignored)
	it := stream.Read(ctx, WithEncoding("base64"))
	defer it.Close()

	chunk, err := it.Next()
	if err != nil && err != Done {
		t.Fatalf("unexpected error: %v", err)
	}

	if !bytes.Equal(chunk.Data, responseData) {
		t.Errorf("got data %v, want %v", chunk.Data, responseData)
	}
}

// TestStreamingWithBase64ReconnectPreservesEncoding tests that encoding is preserved on SSE reconnect
func TestStreamingWithBase64ReconnectPreservesEncoding(t *testing.T) {
	callCount := 0
	testData := []byte("test data")
	encoded := base64.StdEncoding.EncodeToString(testData)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++

		// Always verify encoding is present
		if r.URL.Query().Get("encoding") != "base64" {
			t.Errorf("call %d: expected encoding=base64 query param", callCount)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)

		if callCount == 1 {
			// First call: send data and close (simulating disconnect)
			sseData := "event: data\ndata: " + encoded + "\n\nevent: control\ndata: {\"streamNextOffset\":\"100\"}\n\n"
			w.Write([]byte(sseData))
			// Let the handler return to close the connection
			return
		}

		// Second call: send more data
		sseData := "event: data\ndata: " + encoded + "\n\nevent: control\ndata: {\"streamNextOffset\":\"200\",\"upToDate\":true}\n\n"
		w.Write([]byte(sseData))
	}))
	defer server.Close()

	client := NewClient(WithBaseURL(server.URL))
	stream := client.Stream("/test")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	it := stream.Read(ctx,
		WithLive(LiveModeSSE),
		WithEncoding("base64"),
	)
	defer it.Close()

	// Read first chunk
	chunk1, err := it.Next()
	if err != nil {
		t.Fatalf("first read error: %v", err)
	}
	if !bytes.Equal(chunk1.Data, testData) {
		t.Errorf("first chunk: got %v, want %v", chunk1.Data, testData)
	}

	// Read second chunk (after reconnect)
	chunk2, err := it.Next()
	if err != nil && err != io.EOF {
		t.Fatalf("second read error: %v", err)
	}
	if chunk2 != nil && !bytes.Equal(chunk2.Data, testData) {
		t.Errorf("second chunk: got %v, want %v", chunk2.Data, testData)
	}

	// Verify we made at least 2 calls (reconnected)
	if callCount < 2 {
		t.Errorf("expected at least 2 server calls, got %d", callCount)
	}
}

// makeAllBytes creates a byte slice containing all possible byte values
func makeAllBytes() []byte {
	result := make([]byte, 256)
	for i := 0; i < 256; i++ {
		result[i] = byte(i)
	}
	return result
}

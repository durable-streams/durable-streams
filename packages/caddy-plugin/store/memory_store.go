package store

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// MemoryStore is an in-memory implementation of Store for testing
type MemoryStore struct {
	mu       sync.RWMutex
	streams  map[string]*memoryStream
	longPoll *longPollManager
}

type memoryStream struct {
	metadata StreamMetadata
	messages []Message
	data     []byte // Raw accumulated data for non-JSON streams
}

type longPollManager struct {
	mu      sync.Mutex
	waiters map[string][]chan struct{}
}

// NewMemoryStore creates a new in-memory store
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		streams: make(map[string]*memoryStream),
		longPoll: &longPollManager{
			waiters: make(map[string][]chan struct{}),
		},
	}
}

func (s *MemoryStore) Create(path string, opts CreateOptions) (*StreamMetadata, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if stream already exists (and is not expired)
	if existing, ok := s.streams[path]; ok {
		// If expired, delete it and allow recreation
		if existing.metadata.IsExpired() {
			delete(s.streams, path)
		} else if existing.metadata.ConfigMatches(opts) {
			// Idempotent success - return false to indicate not newly created
			return &existing.metadata, false, nil
		} else {
			return nil, false, ErrConfigMismatch
		}
	}

	// Create new stream
	contentType := opts.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	meta := StreamMetadata{
		Path:          path,
		ContentType:   contentType,
		CurrentOffset: ZeroOffset,
		TTLSeconds:    opts.TTLSeconds,
		ExpiresAt:     opts.ExpiresAt,
		CreatedAt:     time.Now(),
	}

	stream := &memoryStream{
		metadata: meta,
		messages: make([]Message, 0),
		data:     make([]byte, 0),
	}

	// Handle initial data
	if len(opts.InitialData) > 0 {
		newOffset, err := s.appendToStream(stream, opts.InitialData, AppendOptions{}, true) // Allow empty arrays on create
		if err != nil {
			return nil, false, err
		}
		stream.metadata.CurrentOffset = newOffset
	}

	s.streams[path] = stream
	return &stream.metadata, true, nil // true = newly created
}

func (s *MemoryStore) Get(path string) (*StreamMetadata, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	stream, ok := s.streams[path]
	if !ok {
		return nil, ErrStreamNotFound
	}

	// Check if stream has expired
	if stream.metadata.IsExpired() {
		return nil, ErrStreamNotFound // Return not found for expired streams
	}

	meta := stream.metadata // Copy
	return &meta, nil
}

func (s *MemoryStore) Has(path string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	stream, ok := s.streams[path]
	if !ok {
		return false
	}
	// Check if stream has expired
	return !stream.metadata.IsExpired()
}

func (s *MemoryStore) Delete(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.streams[path]; !ok {
		return ErrStreamNotFound
	}
	delete(s.streams, path)
	return nil
}

func (s *MemoryStore) Append(path string, data []byte, opts AppendOptions) (Offset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	stream, ok := s.streams[path]
	if !ok {
		return Offset{}, ErrStreamNotFound
	}

	// Check if stream has expired
	if stream.metadata.IsExpired() {
		return Offset{}, ErrStreamNotFound
	}

	// Validate content type if provided
	if opts.ContentType != "" && !ContentTypeMatches(stream.metadata.ContentType, opts.ContentType) {
		return Offset{}, ErrContentTypeMismatch
	}

	// Validate sequence number if provided
	if opts.Seq != "" {
		if stream.metadata.LastSeq != "" && opts.Seq <= stream.metadata.LastSeq {
			return Offset{}, ErrSequenceConflict
		}
	}

	newOffset, err := s.appendToStream(stream, data, opts, false) // Don't allow empty arrays on append
	if err != nil {
		return Offset{}, err
	}

	stream.metadata.CurrentOffset = newOffset
	if opts.Seq != "" {
		stream.metadata.LastSeq = opts.Seq
	}

	// Notify long-poll waiters
	s.longPoll.notify(path)

	return newOffset, nil
}

// appendToStream handles the actual append logic, including JSON mode
func (s *MemoryStore) appendToStream(stream *memoryStream, data []byte, opts AppendOptions, allowEmpty bool) (Offset, error) {
	isJSON := isJSONContentType(stream.metadata.ContentType)

	if isJSON {
		// JSON mode: parse and potentially flatten arrays
		messages, err := processJSONAppend(data, allowEmpty)
		if err != nil {
			return Offset{}, err
		}

		currentOffset := stream.metadata.CurrentOffset
		for _, msgData := range messages {
			currentOffset = currentOffset.Add(uint64(len(msgData)))
			stream.messages = append(stream.messages, Message{
				Data:   msgData,
				Offset: currentOffset,
			})
		}
		return currentOffset, nil
	}

	// Non-JSON mode: store raw bytes
	newOffset := stream.metadata.CurrentOffset.Add(uint64(len(data)))
	stream.messages = append(stream.messages, Message{
		Data:   data,
		Offset: newOffset,
	})
	stream.data = append(stream.data, data...)
	return newOffset, nil
}

func (s *MemoryStore) Read(path string, offset Offset) ([]Message, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	stream, ok := s.streams[path]
	if !ok {
		return nil, false, ErrStreamNotFound
	}

	// Check if stream has expired
	if stream.metadata.IsExpired() {
		return nil, false, ErrStreamNotFound
	}

	// Find messages after the given offset
	var messages []Message
	for _, msg := range stream.messages {
		if msg.Offset.ByteOffset > offset.ByteOffset {
			messages = append(messages, msg)
		}
	}

	upToDate := offset.Equal(stream.metadata.CurrentOffset) || len(messages) == 0 && len(stream.messages) > 0
	if len(stream.messages) == 0 {
		upToDate = true
	}

	return messages, upToDate, nil
}

func (s *MemoryStore) WaitForMessages(ctx context.Context, path string, offset Offset, timeout time.Duration) ([]Message, bool, error) {
	// First check if there are already messages
	messages, _, err := s.Read(path, offset)
	if err != nil {
		return nil, false, err
	}
	if len(messages) > 0 {
		return messages, false, nil
	}

	// No messages, set up wait
	ch := make(chan struct{}, 1)
	s.longPoll.register(path, ch)
	defer s.longPoll.unregister(path, ch)

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-ch:
		// New data available
		messages, _, err := s.Read(path, offset)
		return messages, false, err
	case <-timer.C:
		// Timeout
		return nil, true, nil
	case <-ctx.Done():
		return nil, false, ctx.Err()
	}
}

func (s *MemoryStore) GetCurrentOffset(path string) (Offset, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	stream, ok := s.streams[path]
	if !ok {
		return Offset{}, ErrStreamNotFound
	}
	return stream.metadata.CurrentOffset, nil
}

func (s *MemoryStore) Close() error {
	return nil
}

// FormatResponse formats messages for HTTP response based on content type
func (s *MemoryStore) FormatResponse(path string, messages []Message) ([]byte, error) {
	s.mu.RLock()
	stream, ok := s.streams[path]
	s.mu.RUnlock()

	if !ok {
		return nil, ErrStreamNotFound
	}

	if isJSONContentType(stream.metadata.ContentType) {
		return formatJSONResponse(messages), nil
	}

	// Non-JSON: concatenate raw data
	var buf bytes.Buffer
	for _, msg := range messages {
		buf.Write(msg.Data)
	}
	return buf.Bytes(), nil
}

// Long-poll manager methods
func (m *longPollManager) register(path string, ch chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.waiters[path] = append(m.waiters[path], ch)
}

func (m *longPollManager) unregister(path string, ch chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()

	waiters := m.waiters[path]
	for i, w := range waiters {
		if w == ch {
			m.waiters[path] = append(waiters[:i], waiters[i+1:]...)
			break
		}
	}
}

func (m *longPollManager) notify(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, ch := range m.waiters[path] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// JSON helper functions
func isJSONContentType(ct string) bool {
	mediaType := strings.ToLower(extractMediaType(ct))
	return mediaType == "application/json"
}

// processJSONAppend processes JSON data for append, flattening top-level arrays
func processJSONAppend(data []byte, allowEmpty bool) ([][]byte, error) {
	// Validate JSON
	if !json.Valid(data) {
		return nil, ErrInvalidJSON
	}

	// Check if it's an array
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var arr []json.RawMessage
		if err := json.Unmarshal(trimmed, &arr); err != nil {
			return nil, ErrInvalidJSON
		}
		if len(arr) == 0 {
			// Empty arrays are allowed on PUT (create) but not on POST (append)
			if !allowEmpty {
				return nil, ErrEmptyJSONArray
			}
			// Return empty slice for empty array on create
			return [][]byte{}, nil
		}
		// Flatten one level
		result := make([][]byte, len(arr))
		for i, elem := range arr {
			result[i] = []byte(elem)
		}
		return result, nil
	}

	// Single value
	return [][]byte{trimmed}, nil
}

// formatJSONResponse formats messages as a JSON array
func formatJSONResponse(messages []Message) []byte {
	if len(messages) == 0 {
		return []byte("[]")
	}

	var buf bytes.Buffer
	buf.WriteByte('[')
	for i, msg := range messages {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(msg.Data)
	}
	buf.WriteByte(']')
	return buf.Bytes()
}

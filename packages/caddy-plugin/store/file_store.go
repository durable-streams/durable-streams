package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FileStore is a file-backed implementation of the Store interface
type FileStore struct {
	dataDir    string
	metaStore  *BboltMetadataStore
	writerPool *FilePool
	longPoll   *longPollManager

	// Cache of stream metadata for quick access
	metaCache   map[string]*StreamMetadata
	dirCache    map[string]string // path -> directory name
	metaCacheMu sync.RWMutex

	// Background cleanup
	cleanupStop chan struct{}
	cleanupDone chan struct{}
}

// FileStoreConfig contains configuration for the file store
type FileStoreConfig struct {
	DataDir         string
	MaxFileHandles  int
	CleanupInterval time.Duration // Interval for background cleanup (0 = disabled)
}

// NewFileStore creates a new file-backed store
func NewFileStore(cfg FileStoreConfig) (*FileStore, error) {
	if cfg.DataDir == "" {
		return nil, fmt.Errorf("data directory is required")
	}

	// Create data directory
	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	// Create bbolt metadata store
	metaDir := filepath.Join(cfg.DataDir, "metadata")
	metaStore, err := NewBboltMetadataStore(metaDir)
	if err != nil {
		return nil, fmt.Errorf("failed to create metadata store: %w", err)
	}

	maxHandles := cfg.MaxFileHandles
	if maxHandles <= 0 {
		maxHandles = 100
	}

	fs := &FileStore{
		dataDir:    cfg.DataDir,
		metaStore:  metaStore,
		writerPool: NewFilePool(maxHandles),
		longPoll: &longPollManager{
			waiters: make(map[string][]chan struct{}),
		},
		metaCache:   make(map[string]*StreamMetadata),
		dirCache:    make(map[string]string),
		cleanupStop: make(chan struct{}),
		cleanupDone: make(chan struct{}),
	}

	// Load existing streams into cache
	if err := fs.loadCache(); err != nil {
		metaStore.Close()
		return nil, fmt.Errorf("failed to load cache: %w", err)
	}

	// Start background cleanup if configured
	if cfg.CleanupInterval > 0 {
		go fs.backgroundCleanup(cfg.CleanupInterval)
	} else {
		close(fs.cleanupDone) // No cleanup, mark as done
	}

	return fs, nil
}

// loadCache loads all stream metadata into the cache
func (s *FileStore) loadCache() error {
	return s.metaStore.ForEach(func(meta *StreamMetadata, dirName string) error {
		s.metaCache[meta.Path] = meta
		s.dirCache[meta.Path] = dirName
		return nil
	})
}

// Create creates a new stream
func (s *FileStore) Create(path string, opts CreateOptions) (*StreamMetadata, bool, error) {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	// Check if stream already exists
	if existing, ok := s.metaCache[path]; ok {
		if existing.ConfigMatches(opts) {
			return existing, false, nil
		}
		return nil, false, ErrConfigMismatch
	}

	// Generate unique directory name
	dirName, err := generateDirectoryName(path)
	if err != nil {
		return nil, false, fmt.Errorf("failed to generate directory name: %w", err)
	}

	// Create stream directory
	streamDir := filepath.Join(s.dataDir, "streams", dirName)
	if err := os.MkdirAll(streamDir, 0755); err != nil {
		return nil, false, fmt.Errorf("failed to create stream directory: %w", err)
	}

	// Create segment file
	segPath := filepath.Join(streamDir, SegmentFileName)
	if err := CreateSegmentFile(segPath); err != nil {
		os.RemoveAll(streamDir)
		return nil, false, err
	}

	// Initialize metadata
	contentType := opts.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	meta := &StreamMetadata{
		Path:          path,
		ContentType:   contentType,
		CurrentOffset: ZeroOffset,
		TTLSeconds:    opts.TTLSeconds,
		ExpiresAt:     opts.ExpiresAt,
		CreatedAt:     time.Now(),
	}

	// Handle initial data
	if len(opts.InitialData) > 0 {
		newOffset, err := s.appendToStream(meta, dirName, opts.InitialData, AppendOptions{}, true) // Allow empty arrays on create
		if err != nil {
			os.RemoveAll(streamDir)
			return nil, false, err
		}
		meta.CurrentOffset = newOffset
	}

	// Store metadata
	if err := s.metaStore.Put(meta, dirName); err != nil {
		os.RemoveAll(streamDir)
		return nil, false, fmt.Errorf("failed to store metadata: %w", err)
	}

	// Update cache
	s.metaCache[path] = meta
	s.dirCache[path] = dirName

	return meta, true, nil
}

// Get returns metadata for a stream
func (s *FileStore) Get(path string) (*StreamMetadata, error) {
	s.metaCacheMu.RLock()
	meta, ok := s.metaCache[path]
	s.metaCacheMu.RUnlock()

	if !ok {
		return nil, ErrStreamNotFound
	}

	// Check if stream has expired
	if meta.IsExpired() {
		return nil, ErrStreamNotFound
	}

	// Return a copy to prevent mutation
	metaCopy := *meta
	return &metaCopy, nil
}

// Has returns true if the stream exists
func (s *FileStore) Has(path string) bool {
	s.metaCacheMu.RLock()
	meta, ok := s.metaCache[path]
	s.metaCacheMu.RUnlock()
	if !ok {
		return false
	}
	// Check if stream has expired
	return !meta.IsExpired()
}

// Delete removes a stream
func (s *FileStore) Delete(path string) error {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	dirName, ok := s.dirCache[path]
	if !ok {
		return ErrStreamNotFound
	}

	// Remove from writer pool
	segPath := filepath.Join(s.dataDir, "streams", dirName, SegmentFileName)
	s.writerPool.Remove(segPath)

	// Delete from bbolt
	if err := s.metaStore.Delete(path); err != nil {
		return err
	}

	// Remove from cache
	delete(s.metaCache, path)
	delete(s.dirCache, path)

	// Async delete directory (rename first for safety)
	streamDir := filepath.Join(s.dataDir, "streams", dirName)
	deletedDir := filepath.Join(s.dataDir, "streams", ".deleted~"+dirName+"~"+fmt.Sprintf("%d", time.Now().UnixNano()))
	os.Rename(streamDir, deletedDir)
	go os.RemoveAll(deletedDir)

	return nil
}

// Append adds data to a stream
func (s *FileStore) Append(path string, data []byte, opts AppendOptions) (Offset, error) {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	meta, ok := s.metaCache[path]
	if !ok {
		return Offset{}, ErrStreamNotFound
	}

	// Check if stream has expired
	if meta.IsExpired() {
		return Offset{}, ErrStreamNotFound
	}

	dirName := s.dirCache[path]

	// Validate content type
	if opts.ContentType != "" && !ContentTypeMatches(meta.ContentType, opts.ContentType) {
		return Offset{}, ErrContentTypeMismatch
	}

	// Validate sequence number
	if opts.Seq != "" {
		if meta.LastSeq != "" && opts.Seq <= meta.LastSeq {
			return Offset{}, ErrSequenceConflict
		}
	}

	// Append to segment
	newOffset, err := s.appendToStream(meta, dirName, data, opts, false) // Don't allow empty arrays on append
	if err != nil {
		return Offset{}, err
	}

	// Update metadata
	meta.CurrentOffset = newOffset
	if opts.Seq != "" {
		meta.LastSeq = opts.Seq
	}

	// Persist to bbolt
	if err := s.metaStore.UpdateOffset(path, newOffset, opts.Seq); err != nil {
		// Log error but don't fail - the file is the source of truth
		// On recovery, we'll reconcile
	}

	// Notify long-poll waiters
	s.longPoll.notify(path)

	return newOffset, nil
}

// appendToStream appends data to the stream's segment file
func (s *FileStore) appendToStream(meta *StreamMetadata, dirName string, data []byte, opts AppendOptions, allowEmpty bool) (Offset, error) {
	segPath := filepath.Join(s.dataDir, "streams", dirName, SegmentFileName)

	file, err := s.writerPool.GetWriter(segPath)
	if err != nil {
		return Offset{}, fmt.Errorf("failed to get writer: %w", err)
	}

	isJSON := IsJSONContentType(meta.ContentType)

	if isJSON {
		// JSON mode: parse and potentially flatten arrays
		messages, err := processJSONAppend(data, allowEmpty)
		if err != nil {
			return Offset{}, err
		}

		currentOffset := meta.CurrentOffset
		for _, msgData := range messages {
			n, err := WriteMessage(file, msgData)
			if err != nil {
				return Offset{}, err
			}
			currentOffset = currentOffset.Add(uint64(n))
		}

		// Sync
		if err := s.writerPool.Sync(segPath); err != nil {
			return Offset{}, err
		}

		return currentOffset, nil
	}

	// Non-JSON mode: store raw bytes as single message
	n, err := WriteMessage(file, data)
	if err != nil {
		return Offset{}, err
	}

	// Sync
	if err := s.writerPool.Sync(segPath); err != nil {
		return Offset{}, err
	}

	return meta.CurrentOffset.Add(uint64(n)), nil
}

// Read reads messages from a stream
func (s *FileStore) Read(path string, offset Offset) ([]Message, bool, error) {
	s.metaCacheMu.RLock()
	meta, ok := s.metaCache[path]
	dirName := s.dirCache[path]
	s.metaCacheMu.RUnlock()

	if !ok {
		return nil, false, ErrStreamNotFound
	}

	// Check if stream has expired
	if meta.IsExpired() {
		return nil, false, ErrStreamNotFound
	}

	// Check if already at tail
	if offset.Equal(meta.CurrentOffset) {
		return nil, true, nil
	}

	segPath := filepath.Join(s.dataDir, "streams", dirName, SegmentFileName)
	reader, err := NewSegmentReader(segPath)
	if err != nil {
		return nil, false, fmt.Errorf("failed to open segment: %w", err)
	}
	defer reader.Close()

	messages, _, err := reader.ReadMessages(offset)
	if err != nil {
		return nil, false, err
	}

	upToDate := len(messages) == 0 || (len(messages) > 0 && messages[len(messages)-1].Offset.Equal(meta.CurrentOffset))

	return messages, upToDate, nil
}

// WaitForMessages waits for new messages
func (s *FileStore) WaitForMessages(ctx context.Context, path string, offset Offset, timeout time.Duration) ([]Message, bool, error) {
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

// GetCurrentOffset returns the current tail offset
func (s *FileStore) GetCurrentOffset(path string) (Offset, error) {
	s.metaCacheMu.RLock()
	meta, ok := s.metaCache[path]
	s.metaCacheMu.RUnlock()

	if !ok {
		return Offset{}, ErrStreamNotFound
	}
	return meta.CurrentOffset, nil
}

// Close releases all resources
func (s *FileStore) Close() error {
	// Stop background cleanup
	close(s.cleanupStop)
	<-s.cleanupDone // Wait for cleanup goroutine to finish

	var lastErr error

	if err := s.writerPool.Close(); err != nil {
		lastErr = err
	}

	if err := s.metaStore.Close(); err != nil {
		lastErr = err
	}

	return lastErr
}

// backgroundCleanup periodically removes expired streams
func (s *FileStore) backgroundCleanup(interval time.Duration) {
	defer close(s.cleanupDone)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-s.cleanupStop:
			return
		case <-ticker.C:
			s.cleanupExpiredStreams()
		}
	}
}

// cleanupExpiredStreams removes all expired streams
func (s *FileStore) cleanupExpiredStreams() {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	var expiredPaths []string
	for path, meta := range s.metaCache {
		if meta.IsExpired() {
			expiredPaths = append(expiredPaths, path)
		}
	}

	for _, path := range expiredPaths {
		dirName := s.dirCache[path]

		// Remove from writer pool
		segPath := filepath.Join(s.dataDir, "streams", dirName, SegmentFileName)
		s.writerPool.Remove(segPath)

		// Delete from bbolt
		s.metaStore.Delete(path)

		// Remove from cache
		delete(s.metaCache, path)
		delete(s.dirCache, path)

		// Async delete directory
		streamDir := filepath.Join(s.dataDir, "streams", dirName)
		deletedDir := filepath.Join(s.dataDir, "streams", ".deleted~"+dirName+"~"+fmt.Sprintf("%d", time.Now().UnixNano()))
		os.Rename(streamDir, deletedDir)
		go os.RemoveAll(deletedDir)
	}
}

// FormatResponse formats messages for HTTP response based on content type
func (s *FileStore) FormatResponse(path string, messages []Message) ([]byte, error) {
	s.metaCacheMu.RLock()
	meta, ok := s.metaCache[path]
	s.metaCacheMu.RUnlock()

	if !ok {
		return nil, ErrStreamNotFound
	}

	if IsJSONContentType(meta.ContentType) {
		return FormatJSONResponse(messages), nil
	}

	// Non-JSON: concatenate raw data
	var buf bytes.Buffer
	for _, msg := range messages {
		buf.Write(msg.Data)
	}
	return buf.Bytes(), nil
}

// generateDirectoryName creates a unique directory name for a stream
// Format: encoded_path~timestamp~random
func generateDirectoryName(path string) (string, error) {
	// URL-encode the path for filesystem safety
	encoded := url.PathEscape(path)

	// Add timestamp
	timestamp := time.Now().UnixNano()

	// Add random suffix
	randomBytes := make([]byte, 4)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	randomHex := hex.EncodeToString(randomBytes)

	return fmt.Sprintf("%s~%d~%s", encoded, timestamp, randomHex), nil
}

// Recovery functions

// RecoverStore performs recovery on a file store, reconciling bbolt with segment files
func RecoverStore(dataDir string) error {
	metaDir := filepath.Join(dataDir, "metadata")
	metaStore, err := NewBboltMetadataStore(metaDir)
	if err != nil {
		return fmt.Errorf("failed to open metadata store: %w", err)
	}
	defer metaStore.Close()

	streamsDir := filepath.Join(dataDir, "streams")

	return metaStore.ForEach(func(meta *StreamMetadata, dirName string) error {
		segPath := filepath.Join(streamsDir, dirName, SegmentFileName)

		// Check if segment exists
		if _, err := os.Stat(segPath); os.IsNotExist(err) {
			// Orphaned metadata - delete it
			return metaStore.Delete(meta.Path)
		}

		// Scan segment to get true offset
		trueOffset, err := ScanSegment(segPath)
		if err != nil {
			return fmt.Errorf("failed to scan segment for %s: %w", meta.Path, err)
		}

		// Reconcile if mismatch
		if !meta.CurrentOffset.Equal(trueOffset) {
			if err := metaStore.UpdateOffset(meta.Path, trueOffset, ""); err != nil {
				return fmt.Errorf("failed to update offset for %s: %w", meta.Path, err)
			}
		}

		return nil
	})
}

// Note: longPollManager and processJSONAppend are defined in memory_store.go
// They are shared between memory and file stores

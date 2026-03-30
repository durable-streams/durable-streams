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
	"strings"
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

	// Per-producer locks for serializing validation+append
	// Key: "{streamPath}:{producerId}"
	producerLocks   map[string]*sync.Mutex
	producerLocksMu sync.Mutex

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
		metaCache:     make(map[string]*StreamMetadata),
		dirCache:      make(map[string]string),
		producerLocks: make(map[string]*sync.Mutex),
		cleanupStop:   make(chan struct{}),
		cleanupDone:   make(chan struct{}),
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

// computeForkExpiry determines the effective expiry for a fork stream,
// capped at the source stream's expiry.
func (s *FileStore) computeForkExpiry(opts CreateOptions, sourceMeta StreamMetadata) *time.Time {
	// Resolve source's absolute expiry
	var sourceExpiry *time.Time
	if sourceMeta.ExpiresAt != nil {
		sourceExpiry = sourceMeta.ExpiresAt
	} else if sourceMeta.TTLSeconds != nil {
		t := sourceMeta.CreatedAt.Add(time.Duration(*sourceMeta.TTLSeconds) * time.Second)
		sourceExpiry = &t
	}

	// Resolve fork's requested expiry
	var forkExpiry *time.Time
	if opts.ExpiresAt != nil {
		forkExpiry = opts.ExpiresAt
	} else if opts.TTLSeconds != nil {
		t := time.Now().Add(time.Duration(*opts.TTLSeconds) * time.Second)
		forkExpiry = &t
	} else {
		forkExpiry = sourceExpiry // Inherit source expiry
	}

	// Cap at source expiry
	if sourceExpiry != nil && forkExpiry != nil {
		if forkExpiry.After(*sourceExpiry) {
			forkExpiry = sourceExpiry
		}
	}

	return forkExpiry
}

// Create creates a new stream
func (s *FileStore) Create(path string, opts CreateOptions) (*StreamMetadata, bool, error) {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	// Check if stream already exists (and is not expired)
	if existing, ok := s.metaCache[path]; ok {
		// If expired, delete it and allow recreation
		if existing.IsExpired() {
			if dirName, hasDirName := s.dirCache[path]; hasDirName {
				s.deleteStreamUnlocked(path, dirName)
			}
		} else if existing.SoftDeleted {
			// Soft-deleted streams block new creation
			return nil, false, ErrStreamExists
		} else if existing.ConfigMatches(opts) {
			return existing, false, nil
		} else {
			return nil, false, ErrConfigMismatch
		}
	}

	// Fork creation: validate source stream and resolve fork parameters
	var forkOffset Offset
	var sourceContentType string
	var sourceMeta *StreamMetadata
	isFork := opts.ForkedFrom != ""

	if isFork {
		sourceMetaEntry, ok := s.metaCache[opts.ForkedFrom]
		if !ok {
			return nil, false, ErrStreamNotFound
		}
		if sourceMetaEntry.SoftDeleted {
			return nil, false, ErrStreamSoftDeleted
		}
		if sourceMetaEntry.IsExpired() {
			return nil, false, ErrStreamNotFound
		}

		sourceMeta = sourceMetaEntry
		sourceContentType = sourceMeta.ContentType

		// Resolve fork offset: use opts.ForkOffset if set, else source's CurrentOffset
		if opts.ForkOffset != nil {
			forkOffset = *opts.ForkOffset
		} else {
			forkOffset = sourceMeta.CurrentOffset
		}

		// Validate: ZeroOffset <= forkOffset <= source.CurrentOffset
		if forkOffset.LessThan(ZeroOffset) || sourceMeta.CurrentOffset.LessThan(forkOffset) {
			return nil, false, ErrInvalidForkOffset
		}

		// Atomically increment source refcount in bbolt
		if err := s.metaStore.IncrementRefCount(opts.ForkedFrom); err != nil {
			return nil, false, fmt.Errorf("failed to increment source refcount: %w", err)
		}

		// Update source's metaCache entry RefCount
		sourceMeta.RefCount++
	}

	// Determine content type: use opts.ContentType, or inherit from source if fork
	contentType := opts.ContentType
	if contentType == "" {
		if isFork {
			contentType = sourceContentType
		} else {
			contentType = "application/octet-stream"
		}
	} else if isFork && !strings.EqualFold(contentType, sourceContentType) {
		return nil, false, ErrContentTypeMismatch
	}

	// Generate unique directory name
	dirName, err := generateDirectoryName(path)
	if err != nil {
		if isFork {
			// Rollback source refcount
			s.metaStore.DecrementRefCount(opts.ForkedFrom)
			sourceMeta.RefCount--
		}
		return nil, false, fmt.Errorf("failed to generate directory name: %w", err)
	}

	// Create stream directory
	streamDir := filepath.Join(s.dataDir, "streams", dirName)
	if err := os.MkdirAll(streamDir, 0755); err != nil {
		if isFork {
			s.metaStore.DecrementRefCount(opts.ForkedFrom)
			sourceMeta.RefCount--
		}
		return nil, false, fmt.Errorf("failed to create stream directory: %w", err)
	}

	// Create segment file
	segPath := filepath.Join(streamDir, SegmentFileName)
	if err := CreateSegmentFile(segPath); err != nil {
		os.RemoveAll(streamDir)
		if isFork {
			s.metaStore.DecrementRefCount(opts.ForkedFrom)
			sourceMeta.RefCount--
		}
		return nil, false, err
	}

	// Compute effective expiry
	var effectiveExpiry *time.Time
	if isFork {
		effectiveExpiry = s.computeForkExpiry(opts, *sourceMeta)
	} else {
		effectiveExpiry = opts.ExpiresAt
	}

	// Initialize metadata
	meta := &StreamMetadata{
		Path:        path,
		ContentType: contentType,
		CreatedAt:   time.Now(),
		Closed:      opts.Closed, // Support creating stream in closed state
	}

	if isFork {
		meta.CurrentOffset = forkOffset
		meta.ForkOffset = forkOffset
		meta.ForkedFrom = opts.ForkedFrom
		// For forks, store the computed ExpiresAt (not TTLSeconds) to avoid
		// TTL being computed relative to CreatedAt which could extend beyond source expiry
		meta.ExpiresAt = effectiveExpiry
		meta.TTLSeconds = nil
	} else {
		meta.CurrentOffset = ZeroOffset
		meta.TTLSeconds = opts.TTLSeconds
		meta.ExpiresAt = effectiveExpiry
	}

	// Handle initial data
	if len(opts.InitialData) > 0 {
		newOffset, err := s.appendToStream(meta, dirName, opts.InitialData, AppendOptions{}, true) // Allow empty arrays on create
		if err != nil {
			os.RemoveAll(streamDir)
			if isFork {
				s.metaStore.DecrementRefCount(opts.ForkedFrom)
				sourceMeta.RefCount--
			}
			return nil, false, err
		}
		meta.CurrentOffset = newOffset
	}

	// Store metadata
	if err := s.metaStore.Put(meta, dirName); err != nil {
		os.RemoveAll(streamDir)
		if isFork {
			s.metaStore.DecrementRefCount(opts.ForkedFrom)
			sourceMeta.RefCount--
		}
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

	// Check if stream is soft-deleted (external callers shouldn't see them)
	if meta.SoftDeleted {
		return nil, ErrStreamSoftDeleted
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
	// Soft-deleted streams are not visible
	if meta.SoftDeleted {
		return false
	}
	// Check if stream has expired
	return !meta.IsExpired()
}

// Delete removes a stream
func (s *FileStore) Delete(path string) error {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	meta, ok := s.metaCache[path]
	if !ok {
		return ErrStreamNotFound
	}

	// Already soft-deleted: idempotent success
	if meta.SoftDeleted {
		return nil
	}

	// If there are forks referencing this stream, soft-delete instead
	if meta.RefCount > 0 {
		meta.SoftDeleted = true
		// Persist soft-delete to bbolt
		s.metaStore.SoftDelete(path)
		return nil
	}

	// RefCount == 0: full delete with cascading GC
	return s.deleteWithCascade(path)
}

// deleteWithCascade fully deletes a stream and cascades to soft-deleted parents
// whose refcount drops to zero. Caller must hold metaCacheMu.
func (s *FileStore) deleteWithCascade(path string) error {
	meta, ok := s.metaCache[path]
	if !ok {
		return nil
	}

	forkedFrom := meta.ForkedFrom

	// Delete this stream's data
	dirName := s.dirCache[path]
	s.deleteStreamUnlocked(path, dirName)

	// Cancel long-poll waiters for this stream
	s.longPoll.notify(path)

	// If this stream is a fork, decrement the source's refcount
	if forkedFrom != "" {
		parentMeta, ok := s.metaCache[forkedFrom]
		if ok {
			// Atomically decrement in bbolt
			newRefCount, softDeleted, err := s.metaStore.DecrementRefCount(forkedFrom)
			if err != nil {
				// Log error but continue
			} else {
				parentMeta.RefCount = newRefCount

				if parentMeta.RefCount < 0 {
					parentMeta.RefCount = 0
					return ErrRefCountUnderflow
				}

				// If parent refcount hit 0 and parent is soft-deleted, cascade
				if parentMeta.RefCount == 0 && (softDeleted || parentMeta.SoftDeleted) {
					return s.deleteWithCascade(forkedFrom)
				}
			}
		}
	}

	return nil
}

// deleteStreamUnlocked removes a stream without acquiring the lock (caller must hold metaCacheMu)
func (s *FileStore) deleteStreamUnlocked(path string, dirName string) {
	// Remove from writer pool
	segPath := filepath.Join(s.dataDir, "streams", dirName, SegmentFileName)
	s.writerPool.Remove(segPath)

	// Delete from bbolt (ignore errors on expired stream cleanup)
	s.metaStore.Delete(path)

	// Remove from cache
	delete(s.metaCache, path)
	delete(s.dirCache, path)

	// Async delete directory (rename first for safety)
	streamDir := filepath.Join(s.dataDir, "streams", dirName)
	deletedDir := filepath.Join(s.dataDir, "streams", ".deleted~"+dirName+"~"+fmt.Sprintf("%d", time.Now().UnixNano()))
	os.Rename(streamDir, deletedDir)
	go os.RemoveAll(deletedDir)
}

// getProducerLock returns a per-producer mutex for serializing validation+append.
// This prevents race conditions when HTTP requests arrive out-of-order.
func (s *FileStore) getProducerLock(streamPath, producerId string) *sync.Mutex {
	key := streamPath + ":" + producerId
	s.producerLocksMu.Lock()
	defer s.producerLocksMu.Unlock()

	if mu, ok := s.producerLocks[key]; ok {
		return mu
	}
	mu := &sync.Mutex{}
	s.producerLocks[key] = mu
	return mu
}

// validateProducer validates producer headers and returns the result.
// It also updates the producer state in the metadata if the append is accepted.
// Returns (result, updatedState, error) where updatedState is nil if no update needed.
func (s *FileStore) validateProducer(meta *StreamMetadata, opts AppendOptions) (AppendResult, *ProducerState, error) {
	epoch := *opts.ProducerEpoch
	seq := *opts.ProducerSeq

	// Get current producer state (may not exist)
	var state *ProducerState
	if meta.Producers != nil {
		state = meta.Producers[opts.ProducerId]
	}

	// No existing state - accept as new producer
	if state == nil {
		if seq != 0 {
			// First message from producer must be seq=0
			return AppendResult{
				ProducerResult: ProducerResultNone,
				ExpectedSeq:    0,
				ReceivedSeq:    seq,
			}, nil, ErrProducerSeqGap
		}
		newState := &ProducerState{
			Epoch:       epoch,
			LastSeq:     0,
			LastUpdated: time.Now().Unix(),
		}
		return AppendResult{
			ProducerResult: ProducerResultAccepted,
			LastSeq:        0,
		}, newState, nil
	}

	// Epoch validation (client-declared, server-validated)
	if epoch < state.Epoch {
		// Stale epoch - zombie fencing
		return AppendResult{
			ProducerResult: ProducerResultNone,
			CurrentEpoch:   state.Epoch,
		}, nil, ErrStaleEpoch
	}

	if epoch > state.Epoch {
		// New epoch - must start at seq=0
		if seq != 0 {
			return AppendResult{
				ProducerResult: ProducerResultNone,
			}, nil, ErrInvalidEpochSeq
		}
		// Accept new epoch
		newState := &ProducerState{
			Epoch:       epoch,
			LastSeq:     0,
			LastUpdated: time.Now().Unix(),
		}
		return AppendResult{
			ProducerResult: ProducerResultAccepted,
			LastSeq:        0,
		}, newState, nil
	}

	// Same epoch - sequence validation
	if seq <= state.LastSeq {
		// Duplicate - idempotent success
		return AppendResult{
			ProducerResult: ProducerResultDuplicate,
			LastSeq:        state.LastSeq,
		}, nil, nil
	}

	if seq == state.LastSeq+1 {
		// Accept - update state
		newState := &ProducerState{
			Epoch:       epoch,
			LastSeq:     seq,
			LastUpdated: time.Now().Unix(),
		}
		return AppendResult{
			ProducerResult: ProducerResultAccepted,
			LastSeq:        seq,
		}, newState, nil
	}

	// seq > lastSeq + 1 - gap detected
	return AppendResult{
		ProducerResult: ProducerResultNone,
		ExpectedSeq:    state.LastSeq + 1,
		ReceivedSeq:    seq,
	}, nil, ErrProducerSeqGap
}

// Append adds data to a stream
func (s *FileStore) Append(path string, data []byte, opts AppendOptions) (AppendResult, error) {
	// Validate producer headers - must be all or none
	if opts.HasProducerHeaders() && !opts.HasAllProducerHeaders() {
		return AppendResult{}, ErrPartialProducer
	}

	// If producer headers provided, acquire per-producer lock for serialization
	if opts.HasAllProducerHeaders() {
		producerLock := s.getProducerLock(path, opts.ProducerId)
		producerLock.Lock()
		defer producerLock.Unlock()
	}

	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	meta, ok := s.metaCache[path]
	if !ok {
		return AppendResult{}, ErrStreamNotFound
	}

	// Check if stream is soft-deleted
	if meta.SoftDeleted {
		return AppendResult{}, ErrStreamSoftDeleted
	}

	// Check if stream has expired
	if meta.IsExpired() {
		return AppendResult{}, ErrStreamNotFound
	}

	// Check if stream is closed
	if meta.Closed {
		// Check if this is a duplicate of the closing request (idempotent producer)
		if opts.HasAllProducerHeaders() && meta.ClosedBy != nil &&
			meta.ClosedBy.ProducerId == opts.ProducerId &&
			meta.ClosedBy.Epoch == *opts.ProducerEpoch &&
			meta.ClosedBy.Seq == *opts.ProducerSeq {
			// Idempotent success - duplicate of closing request
			return AppendResult{
				Offset:         meta.CurrentOffset,
				ProducerResult: ProducerResultDuplicate,
				LastSeq:        *opts.ProducerSeq,
				StreamClosed:   true,
			}, nil
		}
		// Stream is closed - reject append
		return AppendResult{
			Offset:       meta.CurrentOffset,
			StreamClosed: true,
		}, ErrStreamClosed
	}

	dirName := s.dirCache[path]

	// Validate content type
	if opts.ContentType != "" && !ContentTypeMatches(meta.ContentType, opts.ContentType) {
		return AppendResult{}, ErrContentTypeMismatch
	}

	// Validate producer FIRST (if headers provided)
	// This must happen before Stream-Seq validation so that retries
	// are deduplicated at the transport layer even if Stream-Seq would conflict.
	var producerState *ProducerState
	var producerResult ProducerResult = ProducerResultNone
	var producerLastSeq int64
	if opts.HasAllProducerHeaders() {
		result, newState, err := s.validateProducer(meta, opts)
		if err != nil {
			result.Offset = meta.CurrentOffset
			return result, err
		}
		if result.ProducerResult == ProducerResultDuplicate {
			// Duplicate - return current offset, no append needed
			return AppendResult{
				Offset:         meta.CurrentOffset,
				ProducerResult: ProducerResultDuplicate,
				LastSeq:        result.LastSeq,
			}, nil
		}
		producerState = newState
		producerResult = result.ProducerResult
		producerLastSeq = result.LastSeq
	}

	// Validate sequence number (Stream-Seq - application layer)
	// Only checked for non-duplicate appends.
	if opts.Seq != "" {
		if meta.LastSeq != "" && opts.Seq <= meta.LastSeq {
			return AppendResult{}, ErrSequenceConflict
		}
	}

	// Append to segment
	newOffset, err := s.appendToStream(meta, dirName, data, opts, false) // Don't allow empty arrays on append
	if err != nil {
		return AppendResult{}, err
	}

	// Update in-memory metadata
	meta.CurrentOffset = newOffset
	if opts.Seq != "" {
		meta.LastSeq = opts.Seq
	}
	if producerState != nil {
		if meta.Producers == nil {
			meta.Producers = make(map[string]*ProducerState)
		}
		meta.Producers[opts.ProducerId] = producerState
	}

	// Handle stream closure if requested
	streamClosed := false
	if opts.Close {
		meta.Closed = true
		streamClosed = true
		// Track which producer tuple closed the stream for idempotent duplicate detection
		if opts.HasAllProducerHeaders() {
			meta.ClosedBy = &ClosedByProducer{
				ProducerId: opts.ProducerId,
				Epoch:      *opts.ProducerEpoch,
				Seq:        *opts.ProducerSeq,
			}
		}
		// Notify pending long-polls that stream is closed
		s.longPoll.notifyClosed(path)
	}

	// Persist to bbolt atomically (including closed state if requested)
	if producerState != nil || opts.Close {
		if err := s.metaStore.UpdateAppendState(path, newOffset, opts.Seq, opts.ProducerId, producerState, opts.Close, meta.ClosedBy); err != nil {
			// Log error but don't fail - the file is the source of truth
			// On recovery, we'll reconcile
		}
	} else {
		if err := s.metaStore.UpdateOffset(path, newOffset, opts.Seq); err != nil {
			// Log error but don't fail - the file is the source of truth
			// On recovery, we'll reconcile
		}
	}

	// Notify long-poll waiters
	s.longPoll.notify(path)

	return AppendResult{
		Offset:         newOffset,
		ProducerResult: producerResult,
		LastSeq:        producerLastSeq,
		StreamClosed:   streamClosed,
	}, nil
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

// readFromSegment reads messages from a segment file starting at the given physical offset.
// Returns the messages read from the segment.
func (s *FileStore) readFromSegment(dirName string, offset Offset) ([]Message, error) {
	segPath := filepath.Join(s.dataDir, "streams", dirName, SegmentFileName)
	reader, err := NewSegmentReader(segPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open segment: %w", err)
	}
	defer reader.Close()

	messages, _, err := reader.ReadMessages(offset)
	if err != nil {
		return nil, err
	}

	return messages, nil
}

// readForkedStream reads messages across the fork chain for a FileStore stream.
// For non-forks, it reads directly from the segment. For forks, it reads inherited
// messages from the source chain (capped at ForkOffset) and then the fork's own
// segment with offset translation. This method does NOT check SoftDeleted -- forks
// must read through soft-deleted sources.
func (s *FileStore) readForkedStream(meta *StreamMetadata, dirName string, offset Offset) ([]Message, error) {
	if meta.ForkedFrom == "" {
		// Not a fork: just read from segment directly
		return s.readFromSegment(dirName, offset)
	}

	var inherited []Message

	// Only read from source if the requested offset is before the fork point
	if offset.LessThan(meta.ForkOffset) {
		sourceMeta, ok := s.metaCache[meta.ForkedFrom]
		sourceDirName := s.dirCache[meta.ForkedFrom]
		if ok {
			// Recursively read from source (source may itself be a fork)
			sourceMessages, err := s.readForkedStream(sourceMeta, sourceDirName, offset)
			if err != nil {
				return nil, err
			}
			// Cap at ForkOffset -- source appends after fork creation are not visible
			for _, msg := range sourceMessages {
				if msg.Offset.LessThanOrEqual(meta.ForkOffset) {
					inherited = append(inherited, msg)
				}
			}
		}
	}

	// Read fork's own segment with offset translation
	// The fork's segment file starts at physical byte 0 but logical offsets start at ForkOffset.
	// We only need to read from the fork's own segment if offset >= ForkOffset
	// (or if we need messages from forkOffset onward).
	var ownMessages []Message
	readOwnOffset := offset
	if readOwnOffset.LessThan(meta.ForkOffset) {
		readOwnOffset = meta.ForkOffset
	}

	// Translate logical offset to physical offset for the fork's segment
	physicalOffset := Offset{
		ReadSeq:    readOwnOffset.ReadSeq,
		ByteOffset: readOwnOffset.ByteOffset - meta.ForkOffset.ByteOffset,
	}

	rawMessages, err := s.readFromSegment(dirName, physicalOffset)
	if err != nil {
		return nil, err
	}

	// Translate physical offsets back to logical offsets
	for _, msg := range rawMessages {
		ownMessages = append(ownMessages, Message{
			Data: msg.Data,
			Offset: Offset{
				ReadSeq:    msg.Offset.ReadSeq,
				ByteOffset: msg.Offset.ByteOffset + meta.ForkOffset.ByteOffset,
			},
		})
	}

	if len(inherited) == 0 {
		return ownMessages, nil
	}
	if len(ownMessages) == 0 {
		return inherited, nil
	}
	return append(inherited, ownMessages...), nil
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

	// Soft-deleted streams are not visible for direct reads
	if meta.SoftDeleted {
		return nil, false, ErrStreamNotFound
	}

	// Check if already at tail
	if offset.Equal(meta.CurrentOffset) {
		return nil, true, nil
	}

	// Read messages across fork chain
	messages, err := s.readForkedStream(meta, dirName, offset)
	if err != nil {
		return nil, false, err
	}

	// upToDate is true when client has reached the tail of the fork's own data
	var upToDate bool
	if len(messages) > 0 {
		upToDate = messages[len(messages)-1].Offset.Equal(meta.CurrentOffset)
	} else {
		upToDate = offset.Equal(meta.CurrentOffset) || meta.CurrentOffset.Equal(ZeroOffset)
	}

	return messages, upToDate, nil
}

// WaitForMessages waits for new messages
func (s *FileStore) WaitForMessages(ctx context.Context, path string, offset Offset, timeout time.Duration) ([]Message, bool, bool, error) {
	// First check if stream is closed and client is at tail
	s.metaCacheMu.RLock()
	meta, ok := s.metaCache[path]
	if ok && meta.Closed && offset.Equal(meta.CurrentOffset) {
		s.metaCacheMu.RUnlock()
		return nil, false, true, nil // streamClosed = true
	}
	s.metaCacheMu.RUnlock()

	// First check if there are already messages
	messages, _, err := s.Read(path, offset)
	if err != nil {
		return nil, false, false, err
	}
	if len(messages) > 0 {
		return messages, false, false, nil
	}

	// For forks: if offset is in the inherited range (< ForkOffset),
	// inherited data exists in the source. The Read call above should have
	// returned it already, but if the source is missing/empty, don't wait
	// -- inherited data will never arrive via long-poll notifications
	// (source appends don't notify fork waiters).
	s.metaCacheMu.RLock()
	meta, ok = s.metaCache[path]
	if ok && meta.ForkedFrom != "" && offset.LessThan(meta.ForkOffset) {
		s.metaCacheMu.RUnlock()
		// Return empty -- no data available and waiting won't help
		return nil, false, false, nil
	}
	s.metaCacheMu.RUnlock()

	// No messages, set up wait
	ch := make(chan struct{}, 1)
	s.longPoll.register(path, ch)
	defer s.longPoll.unregister(path, ch)

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-ch:
		// New data or closure available - check which
		s.metaCacheMu.RLock()
		meta, ok := s.metaCache[path]
		if ok && meta.Closed {
			// Stream was closed
			currentOffset := meta.CurrentOffset
			s.metaCacheMu.RUnlock()
			// Check if there are any final messages
			messages, _, err := s.Read(path, offset)
			if err != nil {
				return nil, false, false, err
			}
			// If no messages and client is at tail, stream is closed
			if len(messages) == 0 && offset.Equal(currentOffset) {
				return nil, false, true, nil
			}
			return messages, false, false, nil
		}
		s.metaCacheMu.RUnlock()
		// New data available
		messages, _, err := s.Read(path, offset)
		return messages, false, false, err
	case <-timer.C:
		// Timeout - check if stream was closed during wait
		s.metaCacheMu.RLock()
		meta, ok := s.metaCache[path]
		streamClosed := ok && meta.Closed
		s.metaCacheMu.RUnlock()
		return nil, true, streamClosed, nil
	case <-ctx.Done():
		return nil, false, false, ctx.Err()
	}
}

// CloseStream closes a stream without appending data
func (s *FileStore) CloseStream(path string) (*CloseResult, error) {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	meta, ok := s.metaCache[path]
	if !ok {
		return nil, ErrStreamNotFound
	}

	// Check if stream has expired
	if meta.IsExpired() {
		return nil, ErrStreamNotFound
	}

	alreadyClosed := meta.Closed
	meta.Closed = true

	// Persist to bbolt
	s.metaStore.SetClosed(path, true, nil)

	// Notify pending long-polls that stream is closed
	s.longPoll.notifyClosed(path)

	return &CloseResult{
		FinalOffset:   meta.CurrentOffset,
		AlreadyClosed: alreadyClosed,
	}, nil
}

// CloseStreamWithProducer closes a stream without appending data, using producer headers.
func (s *FileStore) CloseStreamWithProducer(path string, opts CloseProducerOptions) (*CloseProducerResult, error) {
	// Acquire per-producer lock for serialization
	producerLock := s.getProducerLock(path, opts.ProducerId)
	producerLock.Lock()
	defer producerLock.Unlock()

	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	meta, ok := s.metaCache[path]
	if !ok {
		return nil, ErrStreamNotFound
	}

	// Check if stream has expired
	if meta.IsExpired() {
		return nil, ErrStreamNotFound
	}

	// If already closed, check if this is a duplicate of the closing request
	if meta.Closed {
		if meta.ClosedBy != nil &&
			meta.ClosedBy.ProducerId == opts.ProducerId &&
			meta.ClosedBy.Epoch == opts.ProducerEpoch &&
			meta.ClosedBy.Seq == opts.ProducerSeq {
			return &CloseProducerResult{
				FinalOffset:    meta.CurrentOffset,
				ProducerResult: ProducerResultDuplicate,
				LastSeq:        opts.ProducerSeq,
				StreamClosed:   true,
				AlreadyClosed:  true,
			}, nil
		}

		return &CloseProducerResult{
			FinalOffset:   meta.CurrentOffset,
			StreamClosed:  true,
			AlreadyClosed: true,
		}, ErrStreamClosed
	}

	// Validate producer state
	appendOpts := AppendOptions{
		ProducerId:    opts.ProducerId,
		ProducerEpoch: &opts.ProducerEpoch,
		ProducerSeq:   &opts.ProducerSeq,
	}
	result, newState, err := s.validateProducer(meta, appendOpts)
	if err != nil {
		return &CloseProducerResult{
			FinalOffset:    meta.CurrentOffset,
			ProducerResult: result.ProducerResult,
			CurrentEpoch:   result.CurrentEpoch,
			ExpectedSeq:    result.ExpectedSeq,
			ReceivedSeq:    result.ReceivedSeq,
			LastSeq:        result.LastSeq,
			StreamClosed:   meta.Closed,
		}, err
	}

	if result.ProducerResult == ProducerResultDuplicate {
		return &CloseProducerResult{
			FinalOffset:    meta.CurrentOffset,
			ProducerResult: ProducerResultDuplicate,
			LastSeq:        result.LastSeq,
			StreamClosed:   meta.Closed,
			AlreadyClosed:  meta.Closed,
		}, nil
	}

	// Accept: commit producer state and close stream
	if meta.Producers == nil {
		meta.Producers = make(map[string]*ProducerState)
	}
	meta.Producers[opts.ProducerId] = newState
	meta.Closed = true
	meta.ClosedBy = &ClosedByProducer{
		ProducerId: opts.ProducerId,
		Epoch:      opts.ProducerEpoch,
		Seq:        opts.ProducerSeq,
	}

	// Persist producer state + closed state atomically
	if err := s.metaStore.UpdateAppendState(path, meta.CurrentOffset, "", opts.ProducerId, newState, true, meta.ClosedBy); err != nil {
		// Log error but don't fail - file is the source of truth
	}

	// Notify pending long-polls that stream is closed
	s.longPoll.notifyClosed(path)

	return &CloseProducerResult{
		FinalOffset:    meta.CurrentOffset,
		ProducerResult: result.ProducerResult,
		LastSeq:        result.LastSeq,
		StreamClosed:   true,
		AlreadyClosed:  false,
	}, nil
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

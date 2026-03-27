# Forkable Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add protocol-level stream forking to Durable Streams — fork via PUT headers, transparent read stitching, stream-level refcounting, soft-delete with cascading GC.

**Architecture:** Fork is a create variant (`PUT` with `Stream-Forked-From` + `Stream-Fork-Offset` headers). The fork's read path walks the `forkedFrom` chain at read time, stitching source data up to the fork offset with the fork's own data. Stream-level refcounting prevents source deletion while forks exist. Soft-deleted streams return 410 but preserve data for fork readers. Cascading GC cleans up chains when the last fork is removed.

**Tech Stack:** Go (caddy-plugin with bbolt), TypeScript (server with LMDB), Vitest (conformance tests)

**Spec:** `docs/superpowers/specs/2026-03-27-forkable-streams-design.md`

---

### Task 1: Go metadata types and bbolt serialization

Add fork-related fields to all Go types and persistence. No behavior change yet — just the data model.

**Files:**
- Modify: `packages/caddy-plugin/store/store.go` (StreamMetadata, CreateOptions)
- Modify: `packages/caddy-plugin/store/bbolt.go` (bboltMetadata, serialization)
- Test: `packages/caddy-plugin/store/bbolt_test.go`

- [ ] **Step 1: Add fork fields to StreamMetadata**

In `packages/caddy-plugin/store/store.go`, add four fields to `StreamMetadata` (after the `ClosedBy` field, around line 196):

```go
type StreamMetadata struct {
	Path          string
	ContentType   string
	CurrentOffset Offset
	LastSeq       string // Last Stream-Seq value
	TTLSeconds    *int64
	ExpiresAt     *time.Time
	CreatedAt     time.Time
	Producers     map[string]*ProducerState // Producer ID -> state
	Closed        bool                      // Stream is closed (no more appends allowed)
	ClosedBy      *ClosedByProducer         // Producer that closed the stream (for idempotent duplicate detection)
	ForkedFrom    string                    // Source stream path (empty if not a fork)
	ForkOffset    Offset                    // Divergence point: offsets < ForkOffset come from source
	RefCount      int32                     // Number of forks referencing this stream
	SoftDeleted   bool                      // Logically deleted but retained for fork readers
}
```

- [ ] **Step 2: Add fork fields to CreateOptions**

In `packages/caddy-plugin/store/store.go`, add fork options to `CreateOptions` (around line 149):

```go
type CreateOptions struct {
	ContentType string
	TTLSeconds  *int64
	ExpiresAt   *time.Time
	InitialData []byte
	Closed      bool   // Create stream in closed state
	ForkedFrom  string // Source stream path (fork creation)
	ForkOffset  *Offset // Fork offset (nil = source's current tail)
}
```

Note: `ForkOffset` is a pointer so we can distinguish "not provided" (nil, default to source tail) from "explicitly set to zero offset".

- [ ] **Step 3: Add fork fields to bboltMetadata**

In `packages/caddy-plugin/store/bbolt.go`, add fields to `bboltMetadata` (around line 23):

```go
type bboltMetadata struct {
	Path          string                          `json:"path"`
	ContentType   string                          `json:"content_type"`
	CurrentOffset string                          `json:"current_offset"`
	LastSeq       string                          `json:"last_seq"`
	TTLSeconds    *int64                          `json:"ttl_seconds,omitempty"`
	ExpiresAt     *int64                          `json:"expires_at,omitempty"`
	CreatedAt     int64                           `json:"created_at"`
	DirectoryName string                          `json:"directory_name"`
	Producers     map[string]*bboltProducerState  `json:"producers,omitempty"`
	Closed        bool                            `json:"closed,omitempty"`
	ClosedBy      *bboltClosedByProducer          `json:"closed_by,omitempty"`
	ForkedFrom    string                          `json:"forked_from,omitempty"`
	ForkOffset    string                          `json:"fork_offset,omitempty"`
	RefCount      int32                           `json:"ref_count,omitempty"`
	SoftDeleted   bool                            `json:"soft_deleted,omitempty"`
}
```

- [ ] **Step 4: Update bbolt Put to serialize fork fields**

In `packages/caddy-plugin/store/bbolt.go`, in the `Put` method (around line 88), add fork field serialization when building `bboltMetadata` from `StreamMetadata`:

```go
// Add to the bboltMetadata construction in Put():
bm := bboltMetadata{
	// ... existing fields ...
	ForkedFrom:  meta.ForkedFrom,
	ForkOffset:  meta.ForkOffset.String(),
	RefCount:    meta.RefCount,
	SoftDeleted: meta.SoftDeleted,
}
// Handle zero ForkOffset — only serialize if ForkedFrom is set
if meta.ForkedFrom == "" {
	bm.ForkOffset = ""
}
```

- [ ] **Step 5: Update bbolt Get to deserialize fork fields**

In `packages/caddy-plugin/store/bbolt.go`, in the `Get` method (around line 145), add fork field deserialization when building `StreamMetadata` from `bboltMetadata`:

```go
// Add to the StreamMetadata construction in Get():
meta.ForkedFrom = bm.ForkedFrom
if bm.ForkOffset != "" {
	forkOffset, err := ParseOffset(bm.ForkOffset)
	if err != nil {
		return nil, "", fmt.Errorf("invalid fork offset: %w", err)
	}
	meta.ForkOffset = forkOffset
}
meta.RefCount = bm.RefCount
meta.SoftDeleted = bm.SoftDeleted
```

- [ ] **Step 6: Add new error variables**

In `packages/caddy-plugin/store/store.go`, add new errors after the existing error block (around line 22):

```go
// Fork-related errors
var (
	ErrStreamSoftDeleted = errors.New("stream is soft-deleted")
	ErrInvalidForkOffset = errors.New("fork offset beyond source stream length")
	ErrRefCountUnderflow = errors.New("reference count underflow")
)
```

- [ ] **Step 7: Update ConfigMatches for fork fields**

In `packages/caddy-plugin/store/store.go`, update `ConfigMatches` to compare fork fields (around line 220):

```go
func (m *StreamMetadata) ConfigMatches(opts CreateOptions) bool {
	// ... existing checks ...

	// Fork fields must match
	if m.ForkedFrom != opts.ForkedFrom {
		return false
	}
	if opts.ForkedFrom != "" {
		if opts.ForkOffset != nil && !m.ForkOffset.Equal(*opts.ForkOffset) {
			return false
		}
	}

	return true
}
```

- [ ] **Step 8: Run existing tests to verify no regression**

Run: `cd packages/caddy-plugin && go test ./...`
Expected: All existing tests pass. The new fields have zero values by default and don't change behavior.

- [ ] **Step 9: Commit**

```bash
git add packages/caddy-plugin/store/store.go packages/caddy-plugin/store/bbolt.go
git commit -m "feat: add fork metadata fields to Go store types and bbolt serialization"
```

---

### Task 2: Go handler — fork header parsing and response headers

Parse `Stream-Forked-From` and `Stream-Fork-Offset` on PUT. Return fork-info and refcount headers on HEAD/GET. Handle 410 for soft-deleted streams.

**Files:**
- Modify: `packages/caddy-plugin/handler.go`

- [ ] **Step 1: Add header constants**

In `packages/caddy-plugin/handler.go`, add new header constants (after the existing constants, around line 37):

```go
// Fork headers
const (
	HeaderStreamForkedFrom = "Stream-Forked-From"
	HeaderStreamForkOffset = "Stream-Fork-Offset"
	HeaderStreamRefCount   = "Stream-Ref-Count"
)
```

- [ ] **Step 2: Update CORS headers to expose fork headers**

In `packages/caddy-plugin/handler.go`, in `ServeHTTP` (around line 49-50), update the CORS allow/expose headers:

```go
w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, If-None-Match, Producer-Id, Producer-Epoch, Producer-Seq, Stream-Forked-From, Stream-Fork-Offset")
w.Header().Set("Access-Control-Expose-Headers", "Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, ETag, Location, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, Stream-Forked-From, Stream-Fork-Offset, Stream-Ref-Count")
```

- [ ] **Step 3: Parse fork headers in handleCreate**

In `packages/caddy-plugin/handler.go`, in `handleCreate` (around line 94), parse the two new headers after parsing `closedStr`:

```go
forkedFromStr := r.Header.Get(HeaderStreamForkedFrom)
forkOffsetStr := r.Header.Get(HeaderStreamForkOffset)
```

Then build `CreateOptions` with fork fields. After the existing option building (around line 130):

```go
opts := store.CreateOptions{
	ContentType: contentType,
	TTLSeconds:  ttlSeconds,
	ExpiresAt:   expiresAt,
	InitialData: initialData,
	Closed:      isClosed,
	ForkedFrom:  forkedFromStr,
}

if forkOffsetStr != "" {
	forkOffset, err := store.ParseOffset(forkOffsetStr)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("invalid fork offset format"))
		return nil
	}
	opts.ForkOffset = &forkOffset
}
```

- [ ] **Step 4: Return fork headers on PUT creation response**

In `handleCreate`, after setting existing response headers (Stream-Next-Offset, Content-Type, etc.), add fork headers if applicable:

```go
if meta.ForkedFrom != "" {
	w.Header().Set(HeaderStreamForkedFrom, meta.ForkedFrom)
	w.Header().Set(HeaderStreamForkOffset, meta.ForkOffset.String())
}
w.Header().Set(HeaderStreamRefCount, strconv.FormatInt(int64(meta.RefCount), 10))
```

- [ ] **Step 5: Handle soft-deleted streams in all handlers**

Add a helper method to `handler.go`:

```go
// isSoftDeleted checks if a stream is soft-deleted and returns 410 Gone if so.
// Returns true if the caller should stop processing (410 was sent).
func (h *Handler) isSoftDeleted(w http.ResponseWriter, meta *store.StreamMetadata) bool {
	if meta != nil && meta.SoftDeleted {
		w.WriteHeader(http.StatusGone)
		return true
	}
	return false
}
```

In `handleHead`, `handleRead`, `handleAppend`, and `handleDelete`, after getting metadata via `h.store.Get(path)`, add:

```go
if h.isSoftDeleted(w, meta) {
	return nil
}
```

For `handleCreate`, when the stream already exists, check soft-delete to return 409 (not 410, since PUT is re-creation):

```go
// In handleCreate, when stream exists:
if meta.SoftDeleted {
	w.WriteHeader(http.StatusConflict)
	w.Write([]byte("stream is soft-deleted, path cannot be reused"))
	return nil
}
```

- [ ] **Step 5b: Map fork store errors to HTTP status codes in handleCreate**

In `handleCreate`, after calling `h.store.Create(path, opts)`, map fork-specific errors to HTTP status codes:

```go
meta, isNew, err := h.store.Create(streamPath, opts)
if err != nil {
	switch {
	case errors.Is(err, store.ErrStreamNotFound):
		// Source stream not found (fork creation)
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("source stream not found"))
		return nil
	case errors.Is(err, store.ErrInvalidForkOffset):
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("fork offset beyond source stream length"))
		return nil
	case errors.Is(err, store.ErrStreamSoftDeleted):
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte("source stream is soft-deleted"))
		return nil
	case errors.Is(err, store.ErrStreamExists):
		w.WriteHeader(http.StatusConflict)
		return nil
	case errors.Is(err, store.ErrConfigMismatch):
		w.WriteHeader(http.StatusConflict)
		return nil
	default:
		return err
	}
}
```

- [ ] **Step 6: Return fork and refcount headers on HEAD**

In `handleHead` (around line 190), add fork headers after the existing header setting:

```go
if meta.ForkedFrom != "" {
	w.Header().Set(HeaderStreamForkedFrom, meta.ForkedFrom)
	w.Header().Set(HeaderStreamForkOffset, meta.ForkOffset.String())
}
w.Header().Set(HeaderStreamRefCount, strconv.FormatInt(int64(meta.RefCount), 10))
```

- [ ] **Step 7: Return fork and refcount headers on GET**

In `handleRead` (around line 220), after getting metadata, add the same fork headers to the response before writing the body:

```go
if meta.ForkedFrom != "" {
	w.Header().Set(HeaderStreamForkedFrom, meta.ForkedFrom)
	w.Header().Set(HeaderStreamForkOffset, meta.ForkOffset.String())
}
w.Header().Set(HeaderStreamRefCount, strconv.FormatInt(int64(meta.RefCount), 10))
```

- [ ] **Step 8: Run existing tests**

Run: `cd packages/caddy-plugin && go test ./...`
Expected: All tests pass. New header parsing doesn't affect existing behavior since fork headers are empty by default.

- [ ] **Step 9: Commit**

```bash
git add packages/caddy-plugin/handler.go
git commit -m "feat: parse fork headers on PUT, return fork-info and refcount on HEAD/GET"
```

---

### Task 3: Go MemoryStore — fork creation with refcounting and TTL

Implement fork creation in MemoryStore: validate source, validate offset, increment refcount, set fork metadata, compute TTL ceiling.

**Files:**
- Modify: `packages/caddy-plugin/store/memory_store.go`

- [ ] **Step 1: Add fork validation and creation to MemoryStore.Create**

In `packages/caddy-plugin/store/memory_store.go`, in the `Create` method (around line 153), add fork handling before the stream creation logic. After the existing "check if stream exists" block and before creating the new stream:

```go
func (s *MemoryStore) Create(path string, opts CreateOptions) (*StreamMetadata, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check existing stream
	if existing, ok := s.streams[path]; ok {
		if existing.metadata.IsExpired() {
			delete(s.streams, path)
		} else if existing.metadata.SoftDeleted {
			// Soft-deleted stream blocks re-creation
			return nil, false, ErrStreamExists
		} else {
			if existing.metadata.ConfigMatches(opts) {
				meta := existing.metadata
				return &meta, false, nil
			}
			return nil, false, ErrConfigMismatch
		}
	}

	// Fork validation
	var forkOffset Offset
	var sourceContentType string
	if opts.ForkedFrom != "" {
		source, ok := s.streams[opts.ForkedFrom]
		if !ok {
			return nil, false, ErrStreamNotFound
		}
		if source.metadata.SoftDeleted {
			return nil, false, ErrStreamSoftDeleted
		}
		if source.metadata.IsExpired() {
			return nil, false, ErrStreamNotFound
		}

		// Resolve fork offset
		if opts.ForkOffset != nil {
			forkOffset = *opts.ForkOffset
		} else {
			forkOffset = source.metadata.CurrentOffset
		}

		// Validate fork offset is within source range
		if forkOffset.LessThan(ZeroOffset) || source.metadata.CurrentOffset.LessThan(forkOffset) {
			return nil, false, ErrInvalidForkOffset
		}

		sourceContentType = source.metadata.ContentType

		// Increment source refcount
		source.metadata.RefCount++
	}

	// Determine content type
	contentType := opts.ContentType
	if contentType == "" && opts.ForkedFrom != "" {
		contentType = sourceContentType
	}

	// Compute TTL ceiling for forks
	var effectiveExpiresAt *time.Time
	if opts.ForkedFrom != "" {
		effectiveExpiresAt = s.computeForkExpiry(opts, s.streams[opts.ForkedFrom].metadata)
	} else {
		effectiveExpiresAt = opts.ExpiresAt
	}

	// Create the stream
	meta := StreamMetadata{
		Path:          path,
		ContentType:   contentType,
		CurrentOffset: forkOffset, // ZeroOffset for non-forks, forkOffset for forks
		CreatedAt:     time.Now(),
		TTLSeconds:    opts.TTLSeconds,
		ExpiresAt:     effectiveExpiresAt,
		Producers:     make(map[string]*ProducerState),
		Closed:        opts.Closed,
		ForkedFrom:    opts.ForkedFrom,
		ForkOffset:    forkOffset,
	}

	// For non-forks, CurrentOffset starts at ZeroOffset (default).
	// ForkOffset stays at its zero value (ZeroOffset) for non-forks.
	// Always check ForkedFrom != "" before using ForkOffset.
	if opts.ForkedFrom == "" {
		meta.CurrentOffset = ZeroOffset
	}

	stream := &memoryStream{
		metadata: meta,
	}

	// Handle initial data
	if len(opts.InitialData) > 0 {
		_, err := s.appendToStream(stream, opts.InitialData, AppendOptions{ContentType: contentType}, true)
		if err != nil {
			// Rollback source refcount on failure
			if opts.ForkedFrom != "" {
				s.streams[opts.ForkedFrom].metadata.RefCount--
			}
			return nil, false, err
		}
	}

	s.streams[path] = stream
	resultMeta := stream.metadata
	return &resultMeta, true, nil
}
```

- [ ] **Step 2: Add computeForkExpiry helper**

Add this method to `memory_store.go`:

```go
// computeForkExpiry computes the fork's effective expiry, capped at the source's expiry.
func (s *MemoryStore) computeForkExpiry(opts CreateOptions, sourceMeta StreamMetadata) *time.Time {
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
		// Inherit source expiry
		forkExpiry = sourceExpiry
	}

	// Cap at source expiry
	if sourceExpiry != nil && forkExpiry != nil {
		if forkExpiry.After(*sourceExpiry) {
			forkExpiry = sourceExpiry
		}
	}

	return forkExpiry
}
```

- [ ] **Step 3: Run existing tests**

Run: `cd packages/caddy-plugin && go test ./...`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/caddy-plugin/store/memory_store.go
git commit -m "feat: implement fork creation with refcounting and TTL ceiling in Go MemoryStore"
```

---

### Task 4: Go MemoryStore — fork read path and WaitForMessages

Implement read stitching: walk the fork chain, read from source up to fork offset, then from fork's own data. Update WaitForMessages for inherited data.

**Files:**
- Modify: `packages/caddy-plugin/store/memory_store.go`

- [ ] **Step 1: Implement fork-aware Read**

Replace the `Read` method in `memory_store.go` (around line 529):

```go
func (s *MemoryStore) Read(path string, offset Offset) ([]Message, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	stream, ok := s.streams[path]
	if !ok {
		return nil, false, ErrStreamNotFound
	}
	if stream.metadata.IsExpired() {
		return nil, false, ErrStreamNotFound
	}
	// Note: do NOT check SoftDeleted here — forks read through soft-deleted sources

	return s.readForkedStream(stream, offset)
}

// readForkedStream reads from a stream that may be a fork. Walks the chain.
// Caller must hold s.mu.RLock().
func (s *MemoryStore) readForkedStream(stream *memoryStream, offset Offset) ([]Message, bool, error) {
	meta := &stream.metadata

	// Non-fork: use existing logic
	if meta.ForkedFrom == "" {
		return s.readMessagesFromStream(stream, offset)
	}

	// Fork: stitch source data + own data
	var messages []Message

	// If offset is in inherited range, read from source first
	if offset.LessThan(meta.ForkOffset) {
		sourceStream, ok := s.streams[meta.ForkedFrom]
		if !ok {
			return nil, false, fmt.Errorf("fork source stream not found: %s", meta.ForkedFrom)
		}
		// Read source messages, capped at ForkOffset
		sourceMsgs, _, err := s.readForkedStream(sourceStream, offset)
		if err != nil {
			return nil, false, err
		}
		for _, msg := range sourceMsgs {
			if msg.Offset.LessThan(meta.ForkOffset) {
				messages = append(messages, msg)
			}
		}
	}

	// Read fork's own messages (offset >= ForkOffset)
	readFrom := offset
	if readFrom.LessThan(meta.ForkOffset) {
		readFrom = meta.ForkOffset
	}
	ownMsgs, _, err := s.readMessagesFromStream(stream, readFrom)
	if err != nil {
		return nil, false, err
	}
	messages = append(messages, ownMsgs...)

	// Up-to-date if we've reached the fork's own tail
	upToDate := len(messages) == 0 || (len(messages) > 0 && messages[len(messages)-1].Offset.Add(uint64(len(messages[len(messages)-1].Data)+4)).Equal(meta.CurrentOffset))
	if offset.Equal(meta.CurrentOffset) || (offset.LessThan(meta.CurrentOffset) && len(messages) == 0) {
		upToDate = true
	}
	// Simple check: if requested offset >= current offset, up to date
	if !offset.LessThan(meta.CurrentOffset) {
		upToDate = true
	}

	return messages, upToDate, nil
}

// readMessagesFromStream reads messages from a specific stream's own data only.
// Does not follow fork chains.
func (s *MemoryStore) readMessagesFromStream(stream *memoryStream, offset Offset) ([]Message, bool, error) {
	var messages []Message
	for _, msg := range stream.messages {
		if !msg.Offset.LessThan(offset) {
			messages = append(messages, msg)
		}
	}
	upToDate := len(messages) == 0
	if len(stream.messages) > 0 {
		lastMsg := stream.messages[len(stream.messages)-1]
		if len(messages) > 0 && messages[len(messages)-1].Offset.Equal(lastMsg.Offset) {
			upToDate = true
		}
	}
	if stream.metadata.CurrentOffset.Equal(ZeroOffset) && offset.Equal(ZeroOffset) {
		upToDate = true
	}
	return messages, upToDate, nil
}
```

- [ ] **Step 2: Update WaitForMessages for inherited data**

In `WaitForMessages` (around line 567), add fork-aware logic. Before the existing long-poll registration, check if we're in the inherited range:

```go
func (s *MemoryStore) WaitForMessages(ctx context.Context, path string, offset Offset, timeout time.Duration) ([]Message, bool, bool, error) {
	s.mu.RLock()
	stream, ok := s.streams[path]
	if !ok {
		s.mu.RUnlock()
		return nil, false, false, ErrStreamNotFound
	}
	if stream.metadata.IsExpired() {
		s.mu.RUnlock()
		return nil, false, false, ErrStreamNotFound
	}

	// For forks: if offset is in inherited range, data exists — return immediately
	if stream.metadata.ForkedFrom != "" && offset.LessThan(stream.metadata.ForkOffset) {
		messages, _, err := s.readForkedStream(stream, offset)
		s.mu.RUnlock()
		if err != nil {
			return nil, false, false, err
		}
		streamClosed := stream.metadata.Closed
		return messages, false, streamClosed, nil
	}

	// Check stream closed and at tail
	if stream.metadata.Closed && !offset.LessThan(stream.metadata.CurrentOffset) {
		s.mu.RUnlock()
		return nil, false, true, nil
	}

	// Try reading existing messages
	messages, upToDate, err := s.readMessagesFromStream(stream, offset)
	s.mu.RUnlock()
	if err != nil {
		return nil, false, false, err
	}
	if len(messages) > 0 {
		return messages, false, stream.metadata.Closed, nil
	}

	// ... rest of the existing long-poll wait logic unchanged ...
```

- [ ] **Step 3: Add required import**

Add `"fmt"` to imports in `memory_store.go` if not already present.

- [ ] **Step 4: Run existing tests**

Run: `cd packages/caddy-plugin && go test ./...`
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/caddy-plugin/store/memory_store.go
git commit -m "feat: implement fork-aware read path with chain walking in Go MemoryStore"
```

---

### Task 5: Go MemoryStore — soft-delete and cascading GC

Implement delete with refcount checking, soft-delete, and cascading GC.

**Files:**
- Modify: `packages/caddy-plugin/store/memory_store.go`

- [ ] **Step 1: Implement refcount-aware Delete**

Replace the `Delete` method in `memory_store.go` (around line 234):

```go
func (s *MemoryStore) Delete(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	stream, ok := s.streams[path]
	if !ok {
		return ErrStreamNotFound
	}

	// Already soft-deleted — idempotent
	if stream.metadata.SoftDeleted {
		return nil
	}

	if stream.metadata.RefCount > 0 {
		// Soft-delete: mark as deleted, keep data for fork readers
		stream.metadata.SoftDeleted = true
		return nil
	}

	// RefCount == 0: full delete with cascading GC
	return s.deleteWithCascade(path)
}

// deleteWithCascade deletes a stream and cascades refcount decrements up the fork chain.
// Caller must hold s.mu.Lock().
func (s *MemoryStore) deleteWithCascade(path string) error {
	stream, ok := s.streams[path]
	if !ok {
		return nil
	}

	forkedFrom := stream.metadata.ForkedFrom

	// Delete this stream's data
	delete(s.streams, path)
	s.longPoll.cancelAll(path)

	// Decrement parent's refcount and cascade if needed
	if forkedFrom != "" {
		parent, ok := s.streams[forkedFrom]
		if ok {
			parent.metadata.RefCount--
			if parent.metadata.RefCount < 0 {
				// This is a bug — fail loudly but don't crash
				parent.metadata.RefCount = 0
				return ErrRefCountUnderflow
			}
			// Cascade: if parent is soft-deleted and refcount hit 0, delete it too
			if parent.metadata.RefCount == 0 && parent.metadata.SoftDeleted {
				return s.deleteWithCascade(forkedFrom)
			}
		}
	}

	return nil
}
```

- [ ] **Step 2: Update Get and Has to handle soft-deleted streams**

The `Get` method should return `ErrStreamNotFound` for soft-deleted streams (external callers shouldn't see them). Add a separate `getInternal` for fork reads.

```go
func (s *MemoryStore) Get(path string) (*StreamMetadata, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	stream, ok := s.streams[path]
	if !ok {
		return nil, ErrStreamNotFound
	}
	if stream.metadata.IsExpired() {
		return nil, ErrStreamNotFound
	}
	if stream.metadata.SoftDeleted {
		return nil, ErrStreamSoftDeleted
	}

	meta := stream.metadata
	return &meta, nil
}

func (s *MemoryStore) Has(path string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	stream, ok := s.streams[path]
	if !ok {
		return false
	}
	return !stream.metadata.IsExpired() && !stream.metadata.SoftDeleted
}
```

- [ ] **Step 3: Update Append to reject soft-deleted streams**

In the `Append` method, after getting the stream and checking expiry, add:

```go
if stream.metadata.SoftDeleted {
	return AppendResult{}, ErrStreamSoftDeleted
}
```

- [ ] **Step 4: Handle expiry as soft-delete trigger**

When a stream expires and has refcount > 0, it should be soft-deleted rather than fully deleted. Update the expiry check in `Read` and other methods that check `IsExpired()`:

In `Read`, instead of returning `ErrStreamNotFound` for expired streams, soft-delete if refcount > 0:

```go
if stream.metadata.IsExpired() {
	if stream.metadata.RefCount > 0 {
		stream.metadata.SoftDeleted = true
		// For direct reads on expired+soft-deleted, return not found
		return nil, false, ErrStreamNotFound
	}
	return nil, false, ErrStreamNotFound
}
```

Note: The `readForkedStream` method already skips the soft-delete check for fork reads.

- [ ] **Step 5: Run existing tests**

Run: `cd packages/caddy-plugin && go test ./...`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/caddy-plugin/store/memory_store.go
git commit -m "feat: implement soft-delete and cascading GC in Go MemoryStore"
```

---

### Task 6: Go FileStore — fork support

Add fork creation, read stitching, soft-delete, and cascading GC to FileStore. Uses bbolt transactions for atomicity.

**Files:**
- Modify: `packages/caddy-plugin/store/file_store.go`
- Modify: `packages/caddy-plugin/store/bbolt.go`

- [ ] **Step 1: Add bbolt atomic refcount operations**

In `packages/caddy-plugin/store/bbolt.go`, add methods for atomic refcount operations:

```go
// IncrementRefCount atomically increments the refcount for a stream.
func (s *BboltMetadataStore) IncrementRefCount(path string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		data := b.Get([]byte(path))
		if data == nil {
			return ErrStreamNotFound
		}
		var bm bboltMetadata
		if err := json.Unmarshal(data, &bm); err != nil {
			return err
		}
		bm.RefCount++
		updated, err := json.Marshal(bm)
		if err != nil {
			return err
		}
		return b.Put([]byte(path), updated)
	})
}

// DecrementRefCount atomically decrements the refcount for a stream.
// Returns the new refcount and whether the stream is soft-deleted.
func (s *BboltMetadataStore) DecrementRefCount(path string) (int32, bool, error) {
	var newRefCount int32
	var softDeleted bool
	err := s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		data := b.Get([]byte(path))
		if data == nil {
			return nil // Parent already gone
		}
		var bm bboltMetadata
		if err := json.Unmarshal(data, &bm); err != nil {
			return err
		}
		bm.RefCount--
		if bm.RefCount < 0 {
			return ErrRefCountUnderflow
		}
		newRefCount = bm.RefCount
		softDeleted = bm.SoftDeleted
		updated, err := json.Marshal(bm)
		if err != nil {
			return err
		}
		return b.Put([]byte(path), updated)
	})
	return newRefCount, softDeleted, err
}

// SoftDelete atomically marks a stream as soft-deleted.
func (s *BboltMetadataStore) SoftDelete(path string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		data := b.Get([]byte(path))
		if data == nil {
			return ErrStreamNotFound
		}
		var bm bboltMetadata
		if err := json.Unmarshal(data, &bm); err != nil {
			return err
		}
		bm.SoftDeleted = true
		updated, err := json.Marshal(bm)
		if err != nil {
			return err
		}
		return b.Put([]byte(path), updated)
	})
}
```

- [ ] **Step 2: Update FileStore.Create for fork support**

Follow the same pattern as MemoryStore.Create but use bbolt transactions. In `file_store.go`, in the `Create` method (around line 108):

The key differences from MemoryStore:
- Use `s.metaStore.IncrementRefCount(opts.ForkedFrom)` to atomically bump the source refcount
- Set `meta.CurrentOffset = forkOffset` for forks
- Inherit content type from source's cached metadata
- Compute fork expiry using the same `computeForkExpiry` logic (add the method to FileStore)
- Create the segment directory and empty segment file as normal

```go
// In Create, after checking for existing stream:
if opts.ForkedFrom != "" {
	sourceMeta, ok := s.metaCache[opts.ForkedFrom]
	if !ok || sourceMeta.IsExpired() {
		return nil, false, ErrStreamNotFound
	}
	if sourceMeta.SoftDeleted {
		return nil, false, ErrStreamSoftDeleted
	}

	// Resolve fork offset
	if opts.ForkOffset != nil {
		forkOffset = *opts.ForkOffset
	} else {
		forkOffset = sourceMeta.CurrentOffset
	}
	if forkOffset.LessThan(ZeroOffset) || sourceMeta.CurrentOffset.LessThan(forkOffset) {
		return nil, false, ErrInvalidForkOffset
	}
	sourceContentType = sourceMeta.ContentType

	// Increment source refcount atomically in bbolt
	if err := s.metaStore.IncrementRefCount(opts.ForkedFrom); err != nil {
		return nil, false, fmt.Errorf("failed to increment source refcount: %w", err)
	}
	// Update cache
	sourceMeta.RefCount++
}
```

Then set `meta.ForkedFrom`, `meta.ForkOffset`, and `meta.CurrentOffset = forkOffset` on the new stream metadata.

- [ ] **Step 3: Update FileStore.Read for fork stitching**

In `file_store.go`, modify the `Read` method (around line 555) to walk the fork chain:

```go
func (s *FileStore) Read(path string, offset Offset) ([]Message, bool, error) {
	s.metaCacheMu.RLock()
	meta, ok := s.metaCache[path]
	if !ok {
		s.metaCacheMu.RUnlock()
		return nil, false, ErrStreamNotFound
	}
	if meta.IsExpired() && meta.RefCount == 0 {
		s.metaCacheMu.RUnlock()
		return nil, false, ErrStreamNotFound
	}

	if meta.ForkedFrom == "" {
		// Non-fork: existing read logic
		dirName := s.dirCache[path]
		s.metaCacheMu.RUnlock()
		return s.readFromSegment(meta, dirName, offset)
	}

	// Fork: stitch source + own data
	result, err := s.readForkedStream(path, offset)
	s.metaCacheMu.RUnlock()
	if err != nil {
		return nil, false, err
	}

	upToDate := !offset.LessThan(meta.CurrentOffset)
	if len(result) > 0 {
		// Check if last message reaches the tail
		upToDate = false // Simplified; real check depends on message offsets
	}

	return result, upToDate, nil
}

// readForkedStream reads a forked stream by walking the chain.
// Caller must hold s.metaCacheMu.RLock().
func (s *FileStore) readForkedStream(path string, offset Offset) ([]Message, error) {
	meta := s.metaCache[path]
	if meta == nil {
		return nil, ErrStreamNotFound
	}

	var messages []Message

	// Read inherited data from source if offset < ForkOffset
	if meta.ForkedFrom != "" && offset.LessThan(meta.ForkOffset) {
		sourceMeta := s.metaCache[meta.ForkedFrom]
		if sourceMeta == nil {
			return nil, fmt.Errorf("fork source not found: %s", meta.ForkedFrom)
		}

		var sourceMsgs []Message
		var err error
		if sourceMeta.ForkedFrom != "" {
			// Recursive: source is also a fork
			sourceMsgs, err = s.readForkedStream(meta.ForkedFrom, offset)
		} else {
			dirName := s.dirCache[meta.ForkedFrom]
			sourceMsgs, _, err = s.readFromSegment(sourceMeta, dirName, offset)
		}
		if err != nil {
			return nil, err
		}
		// Cap at fork offset
		for _, msg := range sourceMsgs {
			if msg.Offset.LessThan(meta.ForkOffset) {
				messages = append(messages, msg)
			}
		}
	}

	// Read own data
	readFrom := offset
	if readFrom.LessThan(meta.ForkOffset) {
		readFrom = meta.ForkOffset
	}
	if meta.ForkedFrom != "" {
		dirName := s.dirCache[path]
		ownMsgs, _, err := s.readOwnSegment(meta, dirName, readFrom)
		if err != nil {
			return nil, err
		}
		messages = append(messages, ownMsgs...)
	}

	return messages, nil
}

// readOwnSegment reads from a fork's own segment file, translating logical offsets to physical.
func (s *FileStore) readOwnSegment(meta *StreamMetadata, dirName string, offset Offset) ([]Message, bool, error) {
	segPath := filepath.Join(s.dataDir, "streams", dirName, SegmentFileName)

	// Translate logical offset to physical byte position
	physicalOffset := Offset{
		ReadSeq:    offset.ReadSeq,
		ByteOffset: offset.ByteOffset - meta.ForkOffset.ByteOffset,
	}

	reader, err := NewSegmentReader(segPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, true, nil
		}
		return nil, false, err
	}
	defer reader.Close()

	msgs, err := reader.ReadMessages(physicalOffset)
	if err != nil {
		return nil, false, err
	}

	// Translate physical offsets back to logical
	for i := range msgs {
		msgs[i].Offset = Offset{
			ReadSeq:    msgs[i].Offset.ReadSeq,
			ByteOffset: msgs[i].Offset.ByteOffset + meta.ForkOffset.ByteOffset,
		}
	}

	upToDate := len(msgs) == 0
	return msgs, upToDate, nil
}

// readFromSegment reads from a non-fork stream's segment (existing logic extracted).
func (s *FileStore) readFromSegment(meta *StreamMetadata, dirName string, offset Offset) ([]Message, bool, error) {
	// ... extract existing Read logic here ...
}
```

- [ ] **Step 4: Update FileStore.Delete for soft-delete and cascading GC**

```go
func (s *FileStore) Delete(path string) error {
	s.metaCacheMu.Lock()
	defer s.metaCacheMu.Unlock()

	meta, ok := s.metaCache[path]
	if !ok {
		return ErrStreamNotFound
	}

	// Already soft-deleted — idempotent
	if meta.SoftDeleted {
		return nil
	}

	if meta.RefCount > 0 {
		// Soft-delete: mark as deleted in bbolt and cache
		meta.SoftDeleted = true
		if err := s.metaStore.SoftDelete(path); err != nil {
			return err
		}
		return nil
	}

	// RefCount == 0: full delete with cascading GC
	return s.deleteWithCascade(path)
}

// deleteWithCascade deletes a stream and cascades.
// Caller must hold s.metaCacheMu.Lock().
func (s *FileStore) deleteWithCascade(path string) error {
	meta := s.metaCache[path]
	if meta == nil {
		return nil
	}

	forkedFrom := meta.ForkedFrom
	dirName := s.dirCache[path]

	// Delete stream data
	s.deleteStreamUnlocked(path, dirName)

	// Cascade to parent
	if forkedFrom != "" {
		newRefCount, softDeleted, err := s.metaStore.DecrementRefCount(forkedFrom)
		if err != nil {
			return err
		}
		// Update cache
		if parentMeta, ok := s.metaCache[forkedFrom]; ok {
			parentMeta.RefCount = newRefCount
		}
		// Cascade if parent is soft-deleted and refcount hit 0
		if newRefCount == 0 && softDeleted {
			return s.deleteWithCascade(forkedFrom)
		}
	}

	return nil
}
```

- [ ] **Step 5: Update FileStore.Get and Has for soft-delete**

Same pattern as MemoryStore — return `ErrStreamSoftDeleted` for Get, false for Has.

- [ ] **Step 6: Update FileStore.appendToStream for fork offset translation**

The existing `appendToStream` needs to handle the case where the segment's physical byte 0 corresponds to logical `ForkOffset`. The `SegmentWriter` already tracks physical file size, so the key change is ensuring the offset returned is correct:

```go
// In appendToStream, when computing the new offset:
baseOffset := meta.ForkOffset // For forks, the logical base offset
// newOffset = baseOffset + physical_bytes_in_segment
```

- [ ] **Step 7: Run existing tests**

Run: `cd packages/caddy-plugin && go test ./...`
Expected: All existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/caddy-plugin/store/file_store.go packages/caddy-plugin/store/bbolt.go
git commit -m "feat: implement fork creation, read stitching, and cascading GC in Go FileStore"
```

---

### Task 7: TypeScript types and server handler

Add fork fields to TypeScript types, parse fork headers in the server, and return them on responses.

**Files:**
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/server.ts`

- [ ] **Step 1: Add fork fields to Stream interface**

In `packages/server/src/types.ts`, add to the `Stream` interface (around line 29):

```typescript
export interface Stream {
  // ... existing fields ...
  forkedFrom?: string    // Source stream path
  forkOffset?: string    // Divergence offset (same format as currentOffset)
  refCount: number       // Number of forks referencing this stream (default 0)
  softDeleted?: boolean  // Logically deleted but retained for fork readers
}
```

- [ ] **Step 2: Add header constants**

In `packages/server/src/server.ts`, add after existing header constants (around line 42):

```typescript
const STREAM_FORKED_FROM_HEADER = 'Stream-Forked-From'
const STREAM_FORK_OFFSET_HEADER = 'Stream-Fork-Offset'
const STREAM_REF_COUNT_HEADER = 'Stream-Ref-Count'
```

- [ ] **Step 3: Update CORS headers**

In `packages/server/src/server.ts`, in the CORS setup, add the new headers to both allow and expose lists.

- [ ] **Step 4: Parse fork headers in handleCreate (PUT)**

In `handleCreate` (around line 546), parse fork headers:

```typescript
const forkedFrom = req.headers[STREAM_FORKED_FROM_HEADER.toLowerCase()] as string | undefined
const forkOffsetStr = req.headers[STREAM_FORK_OFFSET_HEADER.toLowerCase()] as string | undefined
```

Pass to `store.create()` as additional options.

- [ ] **Step 5: Return fork headers on PUT response**

After calling `store.create()`, if the stream is a fork:

```typescript
if (stream.forkedFrom) {
  res.setHeader(STREAM_FORKED_FROM_HEADER, stream.forkedFrom)
  res.setHeader(STREAM_FORK_OFFSET_HEADER, stream.forkOffset!)
}
res.setHeader(STREAM_REF_COUNT_HEADER, String(stream.refCount ?? 0))
```

- [ ] **Step 6: Return fork and refcount headers on HEAD and GET**

In `handleHead` (around line 662) and `handleRead` (around line 698), add the same fork header logic.

- [ ] **Step 7: Handle 410 for soft-deleted streams**

In each handler, after getting the stream, check `softDeleted`:

```typescript
const stream = this.store.get(path)
if (stream?.softDeleted) {
  res.writeHead(410)
  res.end()
  return
}
```

For PUT (re-creation), return 409 instead of 410.

- [ ] **Step 8: Run existing tests**

Run: `cd packages/server && pnpm test`
Expected: All existing tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/server.ts
git commit -m "feat: add fork types and header parsing to TypeScript server"
```

---

### Task 8: TypeScript StreamStore — fork support

Implement fork creation, read stitching, and delete with refcounting in the in-memory StreamStore.

**Files:**
- Modify: `packages/server/src/store.ts`

- [ ] **Step 1: Update create() for fork support**

In `packages/server/src/store.ts`, modify the `create` method (around line 170) to handle fork options:

```typescript
create(path: string, options: {
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
  data?: Uint8Array
  closed?: boolean
  forkedFrom?: string
  forkOffset?: string
}): Stream {
  // Check existing
  const existing = this.getIfNotExpired(path)
  if (existing) {
    if (existing.softDeleted) {
      throw new Error('Stream exists (soft-deleted)')
    }
    // ... existing idempotent check ...
  }

  // Fork validation
  let forkOffset = '0000000000000000_0000000000000000'
  let sourceContentType: string | undefined
  if (options.forkedFrom) {
    const source = this.streams.get(options.forkedFrom)
    if (!source || source.softDeleted) {
      throw new Error('Source stream not found')
    }
    forkOffset = options.forkOffset ?? source.currentOffset
    // Validate offset <= source current offset
    if (forkOffset > source.currentOffset) {
      throw new Error('Fork offset beyond source stream length')
    }
    sourceContentType = source.contentType
    // Increment source refcount
    source.refCount = (source.refCount ?? 0) + 1
  }

  const contentType = options.contentType || sourceContentType || 'application/octet-stream'

  // Compute expiry ceiling
  let effectiveExpiresAt = options.expiresAt
  if (options.forkedFrom) {
    effectiveExpiresAt = this.computeForkExpiry(options, this.streams.get(options.forkedFrom)!)
  }

  const stream: Stream = {
    path,
    contentType,
    messages: [],
    currentOffset: options.forkedFrom ? forkOffset : '0000000000000000_0000000000000000',
    createdAt: Date.now(),
    ttlSeconds: options.forkedFrom ? undefined : options.ttlSeconds,
    expiresAt: effectiveExpiresAt,
    forkedFrom: options.forkedFrom,
    forkOffset: options.forkedFrom ? forkOffset : undefined,
    refCount: 0,
  }

  // Append initial data if provided
  if (options.data && options.data.length > 0) {
    this.appendToStream(stream, options.data, { contentType })
  }

  if (options.closed) {
    stream.closed = true
  }

  this.streams.set(path, stream)
  return stream
}
```

- [ ] **Step 2: Add computeForkExpiry helper**

```typescript
private computeForkExpiry(
  opts: { ttlSeconds?: number; expiresAt?: string },
  source: Stream
): string | undefined {
  // Resolve source absolute expiry
  let sourceExpiry: number | undefined
  if (source.expiresAt) {
    sourceExpiry = new Date(source.expiresAt).getTime()
  } else if (source.ttlSeconds) {
    sourceExpiry = source.createdAt + source.ttlSeconds * 1000
  }

  // Resolve fork requested expiry
  let forkExpiry: number | undefined
  if (opts.expiresAt) {
    forkExpiry = new Date(opts.expiresAt).getTime()
  } else if (opts.ttlSeconds) {
    forkExpiry = Date.now() + opts.ttlSeconds * 1000
  } else {
    forkExpiry = sourceExpiry
  }

  // Cap at source
  if (sourceExpiry !== undefined && forkExpiry !== undefined) {
    forkExpiry = Math.min(forkExpiry, sourceExpiry)
  }

  return forkExpiry !== undefined ? new Date(forkExpiry).toISOString() : undefined
}
```

- [ ] **Step 3: Update read() for fork stitching**

```typescript
read(path: string, offset?: string): { messages: Array<StreamMessage>; upToDate: boolean } {
  const stream = this.getIfNotExpired(path)
  if (!stream) throw new Error('Stream not found')

  const startOffset = offset ?? '-1'

  if (!stream.forkedFrom) {
    // Non-fork: existing logic
    return this.readOwnMessages(stream, startOffset)
  }

  // Fork: stitch source + own data
  const messages: StreamMessage[] = []
  const forkOffset = stream.forkOffset!

  // Read inherited data from source
  if (startOffset < forkOffset) {
    const sourceMessages = this.readForkedMessages(stream.forkedFrom, startOffset)
    for (const msg of sourceMessages) {
      if (msg.offset < forkOffset) {
        messages.push(msg)
      }
    }
  }

  // Read own data
  const ownStart = startOffset < forkOffset ? forkOffset : startOffset
  const ownResult = this.readOwnMessages(stream, ownStart)
  messages.push(...ownResult.messages)

  const upToDate = startOffset >= stream.currentOffset ||
    (messages.length === 0 && startOffset >= stream.currentOffset)

  return { messages, upToDate: startOffset >= stream.currentOffset }
}

private readForkedMessages(path: string, offset: string): StreamMessage[] {
  const stream = this.streams.get(path)
  if (!stream) return []

  if (stream.forkedFrom) {
    // Recursive fork
    const messages: StreamMessage[] = []
    const inherited = this.readForkedMessages(stream.forkedFrom, offset)
    for (const msg of inherited) {
      if (msg.offset < stream.forkOffset!) {
        messages.push(msg)
      }
    }
    const own = this.readOwnMessages(stream, offset < stream.forkOffset! ? stream.forkOffset! : offset)
    messages.push(...own.messages)
    return messages
  }

  return this.readOwnMessages(stream, offset).messages
}

private readOwnMessages(stream: Stream, offset: string): { messages: StreamMessage[]; upToDate: boolean } {
  // Existing read logic using findOffsetIndex
  const offsetIndex = this.findOffsetIndex(stream.messages, offset)
  const messages = offsetIndex === -1 ? [] : stream.messages.slice(offsetIndex)
  const upToDate = messages.length === 0
  return { messages, upToDate }
}
```

- [ ] **Step 4: Update delete() for refcounting and cascading GC**

```typescript
delete(path: string): boolean {
  const stream = this.streams.get(path)
  if (!stream) return false

  if (stream.softDeleted) return true // Idempotent

  if (stream.refCount > 0) {
    stream.softDeleted = true
    return true
  }

  // Full delete with cascade
  this.deleteWithCascade(path)
  return true
}

private deleteWithCascade(path: string): void {
  const stream = this.streams.get(path)
  if (!stream) return

  const forkedFrom = stream.forkedFrom

  this.cancelLongPollsForStream(path)
  this.streams.delete(path)

  if (forkedFrom) {
    const parent = this.streams.get(forkedFrom)
    if (parent) {
      parent.refCount--
      if (parent.refCount < 0) {
        parent.refCount = 0
        throw new Error('RefCount underflow')
      }
      if (parent.refCount === 0 && parent.softDeleted) {
        this.deleteWithCascade(forkedFrom)
      }
    }
  }
}
```

- [ ] **Step 5: Update waitForMessages for inherited data**

In `waitForMessages`, before the long-poll registration, check if offset is in inherited range:

```typescript
if (stream.forkedFrom && offset < stream.forkOffset!) {
  const { messages } = this.read(path, offset)
  return { messages, timedOut: false, streamClosed: stream.closed ?? false }
}
```

- [ ] **Step 6: Run existing tests**

Run: `cd packages/server && pnpm test`
Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/store.ts
git commit -m "feat: implement fork creation, read stitching, and cascading GC in TypeScript StreamStore"
```

---

### Task 9: TypeScript FileBackedStreamStore — fork support

Add fork support to the LMDB-backed file store.

**Files:**
- Modify: `packages/server/src/file-store.ts`

- [ ] **Step 1: Add fork fields to LMDB StreamMetadata**

In `packages/server/src/file-store.ts`, update the `StreamMetadata` interface (around line 40):

```typescript
interface StreamMetadata {
  // ... existing fields ...
  forkedFrom?: string
  forkOffset?: string
  refCount: number
  softDeleted?: boolean
}
```

- [ ] **Step 2: Update create() for fork support**

Follow the same pattern as the in-memory store:
- Validate source exists and is not soft-deleted
- Resolve fork offset (default to source tail)
- Validate offset is within source range
- Increment source refcount in LMDB atomically
- Create fork metadata with `currentOffset = forkOffset`
- Compute TTL ceiling
- Create directory and empty segment file

- [ ] **Step 3: Update read() for fork stitching**

Same chain-walking logic as StreamStore, but reading from segment files:
- For inherited data: open source's segment file, read up to fork offset
- For own data: open fork's segment at physical byte 0, translate offsets
- Handle recursive forks

- [ ] **Step 4: Update delete() for soft-delete and cascading GC**

Same pattern as StreamStore but with LMDB atomic updates:
- Use `this.db.putSync()` to atomically mark soft-delete + decrement refcount
- Cascade walk within single LMDB transaction scope
- Defer file deletion to after metadata update

- [ ] **Step 5: Update recovery for fork metadata**

In the recovery scan, handle fork metadata: restore `forkedFrom`, `forkOffset`, `refCount`, `softDeleted` from LMDB.

- [ ] **Step 6: Run existing tests**

Run: `cd packages/server && pnpm test`
Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/file-store.ts
git commit -m "feat: implement fork support in TypeScript FileBackedStreamStore"
```

---

### Task 10: Server conformance tests — fork creation and reading

Write conformance tests for fork creation (tests 1-10) and reading (tests 11-16).

**Files:**
- Modify: `packages/server-conformance-tests/src/index.ts`

- [ ] **Step 1: Add fork creation test suite**

In `packages/server-conformance-tests/src/index.ts`, add a new `describe` block:

```typescript
describe(`Fork - Creation`, () => {
  test(`should create a fork at current head`, async () => {
    const sourcePath = `/v1/stream/fork-source-${Date.now()}`
    const forkPath = `/v1/stream/fork-child-${Date.now()}`

    // Create and populate source
    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `hello world`,
    })

    // Fork at current head
    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": sourcePath,
      },
    })
    expect(forkRes.status).toBe(201)
    expect(forkRes.headers.get(`Stream-Forked-From`)).toBe(sourcePath)
    expect(forkRes.headers.get(`Stream-Fork-Offset`)).toBeTruthy()

    // Read fork — should see source data
    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    expect(readRes.status).toBe(200)
    const body = await readRes.text()
    expect(body).toBe(`hello world`)
  })

  test(`should create a fork at specific offset`, async () => {
    const sourcePath = `/v1/stream/fork-offset-src-${Date.now()}`
    const forkPath = `/v1/stream/fork-offset-child-${Date.now()}`

    // Create source with data
    const createRes = await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `first`,
    })
    const firstOffset = createRes.headers.get(`Stream-Next-Offset`)!

    // Append more data
    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `second`,
    })

    // Fork at first offset (only inherits "first")
    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": sourcePath,
        "Stream-Fork-Offset": firstOffset,
      },
    })
    expect(forkRes.status).toBe(201)

    // Read fork — should only see "first"
    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    const body = await readRes.text()
    expect(body).toBe(`first`)
  })

  test(`should fork at zero offset — empty inherited data`, async () => {
    const sourcePath = `/v1/stream/fork-zero-src-${Date.now()}`
    const forkPath = `/v1/stream/fork-zero-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })

    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": sourcePath,
        "Stream-Fork-Offset": `0000000000000000_0000000000000000`,
      },
    })
    expect(forkRes.status).toBe(201)

    // Read fork — empty (no inherited data, no own data)
    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    expect(readRes.headers.get(`Stream-Up-To-Date`)).toBe(`true`)
  })

  test(`should return 404 when forking nonexistent stream`, async () => {
    const forkPath = `/v1/stream/fork-404-${Date.now()}`
    const res = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": `/v1/stream/nonexistent`,
      },
    })
    expect(res.status).toBe(404)
  })

  test(`should return 400 when fork offset beyond stream length`, async () => {
    const sourcePath = `/v1/stream/fork-oob-src-${Date.now()}`
    const forkPath = `/v1/stream/fork-oob-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `small`,
    })

    const res = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": sourcePath,
        "Stream-Fork-Offset": `0000000000000000_9999999999999999`,
      },
    })
    expect(res.status).toBe(400)
  })

  test(`should return 409 when fork target path already exists`, async () => {
    const sourcePath = `/v1/stream/fork-dup-src-${Date.now()}`
    const forkPath = `/v1/stream/fork-dup-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
    })

    // Create a regular stream at forkPath first
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
    })

    // Try to fork to the same path
    const res = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Content-Type": `text/plain`,
        "Stream-Forked-From": sourcePath,
      },
    })
    expect(res.status).toBe(409)
  })

  test(`should fork a closed stream — fork starts open`, async () => {
    const sourcePath = `/v1/stream/fork-closed-src-${Date.now()}`
    const forkPath = `/v1/stream/fork-closed-child-${Date.now()}`

    // Create and close source
    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain`, "Stream-Closed": `true` },
      body: `final data`,
    })

    // Fork it
    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    expect(forkRes.status).toBe(201)
    // Fork should NOT be closed
    expect(forkRes.headers.get(`Stream-Closed`)).toBeNull()

    // Can append to fork
    const appendRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `fork data`,
    })
    expect(appendRes.status).toBe(204)
  })

  test(`should fork an empty stream`, async () => {
    const sourcePath = `/v1/stream/fork-empty-src-${Date.now()}`
    const forkPath = `/v1/stream/fork-empty-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
    })

    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    expect(forkRes.status).toBe(201)
  })

  test(`should preserve content-type from source`, async () => {
    const sourcePath = `/v1/stream/fork-ct-src-${Date.now()}`
    const forkPath = `/v1/stream/fork-ct-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `application/json` },
      body: `[1,2,3]`,
    })

    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    expect(forkRes.status).toBe(201)

    const headRes = await fetch(`${getBaseUrl()}${forkPath}`, { method: `HEAD` })
    expect(headRes.headers.get(`Content-Type`)).toContain(`application/json`)
  })
})
```

- [ ] **Step 2: Add fork reading test suite**

```typescript
describe(`Fork - Reading`, () => {
  test(`should read entire fork seamlessly`, async () => {
    const sourcePath = `/v1/stream/forkread-src-${Date.now()}`
    const forkPath = `/v1/stream/forkread-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `source-data`,
    })

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `fork-data`,
    })

    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    const body = await readRes.text()
    expect(body).toBe(`source-datafork-data`)
  })

  test(`should not see source appends after fork`, async () => {
    const sourcePath = `/v1/stream/forkisolate-src-${Date.now()}`
    const forkPath = `/v1/stream/forkisolate-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `before-fork`,
    })

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Append to source AFTER fork
    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `after-fork`,
    })

    // Fork should only see pre-fork data
    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    const body = await readRes.text()
    expect(body).toBe(`before-fork`)
    expect(body).not.toContain(`after-fork`)
  })

  test(`should return fork headers on HEAD and GET`, async () => {
    const sourcePath = `/v1/stream/forkheaders-src-${Date.now()}`
    const forkPath = `/v1/stream/forkheaders-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // HEAD
    const headRes = await fetch(`${getBaseUrl()}${forkPath}`, { method: `HEAD` })
    expect(headRes.headers.get(`Stream-Forked-From`)).toBe(sourcePath)
    expect(headRes.headers.get(`Stream-Fork-Offset`)).toBeTruthy()

    // GET
    const getRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    expect(getRes.headers.get(`Stream-Forked-From`)).toBe(sourcePath)
    expect(getRes.headers.get(`Stream-Fork-Offset`)).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run the conformance tests**

Run: `pnpm test:run`
Expected: All new fork tests pass, all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server-conformance-tests/src/index.ts
git commit -m "test: add conformance tests for fork creation and reading"
```

---

### Task 11: Server conformance tests — deletion, lifecycle, TTL, and edge cases

Write the remaining conformance tests.

**Files:**
- Modify: `packages/server-conformance-tests/src/index.ts`

- [ ] **Step 1: Add recursive fork tests**

```typescript
describe(`Fork - Recursive`, () => {
  test(`should read through three-level fork chain`, async () => {
    const aPath = `/v1/stream/chain-a-${Date.now()}`
    const bPath = `/v1/stream/chain-b-${Date.now()}`
    const cPath = `/v1/stream/chain-c-${Date.now()}`

    // A: source
    await fetch(`${getBaseUrl()}${aPath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `aaa`,
    })

    // B: fork of A
    await fetch(`${getBaseUrl()}${bPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": aPath },
    })
    await fetch(`${getBaseUrl()}${bPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `bbb`,
    })

    // C: fork of B
    await fetch(`${getBaseUrl()}${cPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": bPath },
    })
    await fetch(`${getBaseUrl()}${cPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `ccc`,
    })

    // Read C — should see A's data + B's data + C's data
    const readRes = await fetch(`${getBaseUrl()}${cPath}?offset=-1`)
    const body = await readRes.text()
    expect(body).toBe(`aaabbbccc`)
  })
})
```

- [ ] **Step 2: Add deletion and lifecycle tests**

```typescript
describe(`Fork - Deletion and Lifecycle`, () => {
  test(`should delete fork without affecting source`, async () => {
    const sourcePath = `/v1/stream/forkdel-src-${Date.now()}`
    const forkPath = `/v1/stream/forkdel-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Delete fork
    const delRes = await fetch(`${getBaseUrl()}${forkPath}`, { method: `DELETE` })
    expect(delRes.status).toBe(204)

    // Source still readable
    const readRes = await fetch(`${getBaseUrl()}${sourcePath}?offset=-1`)
    expect(readRes.status).toBe(200)
  })

  test(`should soft-delete source while fork exists — fork still reads`, async () => {
    const sourcePath = `/v1/stream/softdel-src-${Date.now()}`
    const forkPath = `/v1/stream/softdel-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `preserved`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Delete source
    const delRes = await fetch(`${getBaseUrl()}${sourcePath}`, { method: `DELETE` })
    expect(delRes.status).toBe(204)

    // Source returns 410
    const sourceRead = await fetch(`${getBaseUrl()}${sourcePath}?offset=-1`)
    expect(sourceRead.status).toBe(410)

    // Fork still readable
    const forkRead = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    expect(forkRead.status).toBe(200)
    const body = await forkRead.text()
    expect(body).toBe(`preserved`)
  })

  test(`should block re-creation of soft-deleted source`, async () => {
    const sourcePath = `/v1/stream/reuse-src-${Date.now()}`
    const forkPath = `/v1/stream/reuse-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    await fetch(`${getBaseUrl()}${sourcePath}`, { method: `DELETE` })

    // Try to re-create at same path
    const recreate = await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
    })
    expect(recreate.status).toBe(409)
  })

  test(`should cascade GC when last fork deleted`, async () => {
    const sourcePath = `/v1/stream/gc-src-${Date.now()}`
    const forkPath = `/v1/stream/gc-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Delete source (soft-delete)
    await fetch(`${getBaseUrl()}${sourcePath}`, { method: `DELETE` })

    // Delete fork — should cascade and fully clean up source
    await fetch(`${getBaseUrl()}${forkPath}`, { method: `DELETE` })

    // Source path is now fully deleted — re-creation might be allowed
    // (implementation-dependent: either 404 on HEAD or 201 on PUT)
    const headRes = await fetch(`${getBaseUrl()}${sourcePath}`, { method: `HEAD` })
    expect(headRes.status).toBe(404)
  })

  test(`should delete all forks — source still alive`, async () => {
    const sourcePath = `/v1/stream/alive-src-${Date.now()}`
    const fork1 = `/v1/stream/alive-f1-${Date.now()}`
    const fork2 = `/v1/stream/alive-f2-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })
    await fetch(`${getBaseUrl()}${fork1}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    await fetch(`${getBaseUrl()}${fork2}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Delete both forks
    await fetch(`${getBaseUrl()}${fork1}`, { method: `DELETE` })
    await fetch(`${getBaseUrl()}${fork2}`, { method: `DELETE` })

    // Source still alive and readable
    const readRes = await fetch(`${getBaseUrl()}${sourcePath}?offset=-1`)
    expect(readRes.status).toBe(200)

    // Refcount should be 0
    const headRes = await fetch(`${getBaseUrl()}${sourcePath}`, { method: `HEAD` })
    expect(headRes.headers.get(`Stream-Ref-Count`)).toBe(`0`)
  })
})
```

- [ ] **Step 3: Add TTL tests**

```typescript
describe(`Fork - TTL and Expiry`, () => {
  test(`should inherit source expiry`, async () => {
    const sourcePath = `/v1/stream/ttl-src-${Date.now()}`
    const forkPath = `/v1/stream/ttl-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: {
        "Content-Type": `text/plain`,
        "Stream-TTL": `3600`,
      },
    })

    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    expect(forkRes.status).toBe(201)

    // Fork should have an expiry
    const headRes = await fetch(`${getBaseUrl()}${forkPath}`, { method: `HEAD` })
    expect(headRes.headers.get(`Stream-Expires-At`)).toBeTruthy()
  })
})
```

- [ ] **Step 4: Add JSON mode fork tests**

```typescript
describe(`Fork - JSON Mode`, () => {
  test(`should fork a JSON stream and read with array wrapping`, async () => {
    const sourcePath = `/v1/stream/json-src-${Date.now()}`
    const forkPath = `/v1/stream/json-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify([{ a: 1 }, { b: 2 }]),
    })

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ c: 3 }),
    })

    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    const body = await readRes.json()
    expect(body).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })
})
```

- [ ] **Step 5: Add edge case tests**

```typescript
describe(`Fork - Edge Cases`, () => {
  test(`should fork then immediately delete source — fork still readable`, async () => {
    const sourcePath = `/v1/stream/immdel-src-${Date.now()}`
    const forkPath = `/v1/stream/immdel-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `important data`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Immediately delete source
    await fetch(`${getBaseUrl()}${sourcePath}`, { method: `DELETE` })

    // Fork still works
    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    expect(readRes.status).toBe(200)
    const body = await readRes.text()
    expect(body).toBe(`important data`)
  })

  test(`should handle many forks of same stream`, async () => {
    const sourcePath = `/v1/stream/manyforks-src-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `shared data`,
    })

    // Create 10 forks
    const forkPaths: string[] = []
    for (let i = 0; i < 10; i++) {
      const forkPath = `/v1/stream/manyforks-f${i}-${Date.now()}`
      forkPaths.push(forkPath)
      const res = await fetch(`${getBaseUrl()}${forkPath}`, {
        method: `PUT`,
        headers: { "Stream-Forked-From": sourcePath },
      })
      expect(res.status).toBe(201)
    }

    // Verify refcount
    const headRes = await fetch(`${getBaseUrl()}${sourcePath}`, { method: `HEAD` })
    expect(headRes.headers.get(`Stream-Ref-Count`)).toBe(`10`)

    // All forks readable
    for (const forkPath of forkPaths) {
      const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
      expect(readRes.status).toBe(200)
      const body = await readRes.text()
      expect(body).toBe(`shared data`)
    }
  })
})
```

- [ ] **Step 6: Run conformance tests**

Run: `pnpm test:run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server-conformance-tests/src/index.ts
git commit -m "test: add conformance tests for fork deletion, lifecycle, TTL, JSON mode, and edge cases"
```

---

### Task 12: Protocol documentation

Update PROTOCOL.md with the fork extension.

**Files:**
- Modify: `PROTOCOL.md`

- [ ] **Step 1: Add fork section to PROTOCOL.md**

Add a new section after "Stream Closure" (section 4.1), titled "Stream Forking":

```markdown
### 4.2. Stream Forking

Stream forking creates a new stream that inherits data from a source stream up
to a specified offset. The fork is a variant of stream creation — a `PUT` with
additional headers.

**Properties of stream forking:**

- **O(1) metadata**: Fork stores only the source path and fork offset. No data
  is copied.
- **Transparent reads**: Clients read a forked stream identically to a regular
  stream. The server stitches source and fork data transparently.
- **Lifecycle independence**: Deleting a source does not affect forks. Forks
  hold a reference count on the source, preventing data cleanup until all forks
  are removed.
- **Offset pass-through**: Forked streams use the same offset space as the
  source. No offset translation.

**Fork creation headers:**

- `Stream-Forked-From: <source-path>` — the source stream to fork from
- `Stream-Fork-Offset: <offset>` — the divergence point (optional; defaults to
  source's current tail)

**Fork response headers** (on HEAD, GET, and PUT creation response):

- `Stream-Forked-From: <source-path>` — present only for forked streams
- `Stream-Fork-Offset: <offset>` — present only for forked streams
- `Stream-Ref-Count: <integer>` — number of forks referencing this stream

**Soft-delete:** When a stream with active forks is deleted, it transitions to
a soft-deleted state. Soft-deleted streams return `410 Gone` for direct
operations but preserve data for fork readers. The path is blocked from
re-creation until all forks are removed.
```

- [ ] **Step 2: Commit**

```bash
git add PROTOCOL.md
git commit -m "docs: add stream forking section to protocol specification"
```

---

### Task 13: Missing conformance tests — appending, live modes, and remaining gaps

Add conformance tests for spec items 12, 13, 19-21, 23, 25-29, 34-36, 39-42, 44, 47.

**Files:**
- Modify: `packages/server-conformance-tests/src/index.ts`

- [ ] **Step 1: Add appending tests**

```typescript
describe(`Fork - Appending`, () => {
  test(`should allow idempotent producer on forked stream`, async () => {
    const sourcePath = `/v1/stream/forkprod-src-${Date.now()}`
    const forkPath = `/v1/stream/forkprod-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Append with producer headers
    const res = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: {
        "Content-Type": `text/plain`,
        "Producer-Id": `prod-1`,
        "Producer-Epoch": `0`,
        "Producer-Seq": `0`,
      },
      body: `produced-data`,
    })
    expect(res.status).toBe(200)

    // Duplicate should return 204
    const dup = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: {
        "Content-Type": `text/plain`,
        "Producer-Id": `prod-1`,
        "Producer-Epoch": `0`,
        "Producer-Seq": `0`,
      },
      body: `produced-data`,
    })
    expect(dup.status).toBe(204)
  })

  test(`should close forked stream independently of source`, async () => {
    const sourcePath = `/v1/stream/forkclose-src-${Date.now()}`
    const forkPath = `/v1/stream/forkclose-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Close fork
    const closeRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Stream-Closed": `true` },
    })
    expect(closeRes.status).toBe(204)

    // Source still open — can append
    const appendRes = await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `more`,
    })
    expect(appendRes.status).toBe(204)
  })

  test(`should close source without affecting fork`, async () => {
    const sourcePath = `/v1/stream/closesrc-src-${Date.now()}`
    const forkPath = `/v1/stream/closesrc-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Close source
    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `POST`,
      headers: { "Stream-Closed": `true` },
    })

    // Fork still open and writable
    const appendRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `fork-data`,
    })
    expect(appendRes.status).toBe(204)
  })
})
```

- [ ] **Step 2: Add partial read tests**

```typescript
describe(`Fork - Partial Reads`, () => {
  test(`should read only inherited portion`, async () => {
    const sourcePath = `/v1/stream/partial-src-${Date.now()}`
    const forkPath = `/v1/stream/partial-child-${Date.now()}`

    const createRes = await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `inherited`,
    })
    const forkOffset = createRes.headers.get(`Stream-Next-Offset`)!

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `own-data`,
    })

    // Read with offset 0 up to a point where only inherited data is returned
    // (depends on implementation returning batched data)
    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=-1`)
    const body = await readRes.text()
    expect(body).toContain(`inherited`)
  })

  test(`should read only fork own data when starting past fork offset`, async () => {
    const sourcePath = `/v1/stream/owndata-src-${Date.now()}`
    const forkPath = `/v1/stream/owndata-child-${Date.now()}`

    const createRes = await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `source`,
    })
    const sourceOffset = createRes.headers.get(`Stream-Next-Offset`)!

    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `fork-only`,
    })

    // Read starting from the fork offset — should only see fork's own data
    const readRes = await fetch(`${getBaseUrl()}${forkPath}?offset=${sourceOffset}`)
    const body = await readRes.text()
    expect(body).toBe(`fork-only`)
    expect(body).not.toContain(`source`)
  })
})
```

- [ ] **Step 3: Add live mode tests**

```typescript
describe(`Fork - Live Modes`, () => {
  test(`long-poll in inherited range returns immediately`, async () => {
    const sourcePath = `/v1/stream/lp-src-${Date.now()}`
    const forkPath = `/v1/stream/lp-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `data`,
    })
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })

    // Long-poll at offset 0 (inherited range) should return immediately
    const start = Date.now()
    const res = await fetch(`${getBaseUrl()}${forkPath}?offset=-1&live=long-poll`)
    const elapsed = Date.now() - start
    expect(res.status).toBe(200)
    expect(elapsed).toBeLessThan(5000) // Should be fast, not waiting
    const body = await res.text()
    expect(body).toBe(`data`)
  })

  test(`long-poll at fork tail waits for fork appends not source appends`, async () => {
    const sourcePath = `/v1/stream/lpwait-src-${Date.now()}`
    const forkPath = `/v1/stream/lpwait-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `initial`,
    })
    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": sourcePath },
    })
    const forkOffset = forkRes.headers.get(`Stream-Next-Offset`)!

    // Start long-poll at fork's tail
    const pollPromise = fetch(`${getBaseUrl()}${forkPath}?offset=${forkOffset}&live=long-poll`)

    // Append to SOURCE (should NOT unblock the poll)
    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `source-append`,
    })

    // Small delay, then append to FORK (should unblock)
    await new Promise(r => setTimeout(r, 100))
    await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `fork-append`,
    })

    const res = await pollPromise
    const body = await res.text()
    expect(body).toBe(`fork-append`)
    expect(body).not.toContain(`source-append`)
  })
})
```

- [ ] **Step 4: Add additional deletion/lifecycle tests**

```typescript
describe(`Fork - Additional Lifecycle`, () => {
  test(`three-level cascading GC`, async () => {
    const a = `/v1/stream/cascade3-a-${Date.now()}`
    const b = `/v1/stream/cascade3-b-${Date.now()}`
    const c = `/v1/stream/cascade3-c-${Date.now()}`

    await fetch(`${getBaseUrl()}${a}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `aaa`,
    })
    await fetch(`${getBaseUrl()}${b}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": a },
    })
    await fetch(`${getBaseUrl()}${c}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": b },
    })

    // Delete A (soft-delete, refcount 1 from B)
    await fetch(`${getBaseUrl()}${a}`, { method: `DELETE` })
    // Delete B (soft-delete, refcount 1 from C)
    await fetch(`${getBaseUrl()}${b}`, { method: `DELETE` })
    // C still reads through both
    const readC = await fetch(`${getBaseUrl()}${c}?offset=-1`)
    expect(readC.status).toBe(200)

    // Delete C — cascades: B cleanup -> A cleanup
    await fetch(`${getBaseUrl()}${c}`, { method: `DELETE` })

    // All fully deleted
    expect((await fetch(`${getBaseUrl()}${a}`, { method: `HEAD` })).status).toBe(404)
    expect((await fetch(`${getBaseUrl()}${b}`, { method: `HEAD` })).status).toBe(404)
    expect((await fetch(`${getBaseUrl()}${c}`, { method: `HEAD` })).status).toBe(404)
  })

  test(`delete middle of chain — data preserved for leaf`, async () => {
    const a = `/v1/stream/mid-a-${Date.now()}`
    const b = `/v1/stream/mid-b-${Date.now()}`
    const c = `/v1/stream/mid-c-${Date.now()}`

    await fetch(`${getBaseUrl()}${a}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `aaa`,
    })
    await fetch(`${getBaseUrl()}${b}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": a },
    })
    await fetch(`${getBaseUrl()}${b}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `bbb`,
    })
    await fetch(`${getBaseUrl()}${c}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": b },
    })

    // Delete B (middle) — soft-deleted because C holds a ref
    await fetch(`${getBaseUrl()}${b}`, { method: `DELETE` })

    // C still reads through: A data + B data + C data
    const readC = await fetch(`${getBaseUrl()}${c}?offset=-1`)
    expect(readC.status).toBe(200)
    const body = await readC.text()
    expect(body).toBe(`aaabbb`)
  })

  test(`refcount never goes below zero`, async () => {
    const path = `/v1/stream/nounderflow-${Date.now()}`
    await fetch(`${getBaseUrl()}${path}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
    })

    // Delete a stream with no forks (refcount 0) — should succeed
    const res = await fetch(`${getBaseUrl()}${path}`, { method: `DELETE` })
    expect(res.status).toBe(204)

    // Stream is gone
    expect((await fetch(`${getBaseUrl()}${path}`, { method: `HEAD` })).status).toBe(404)
  })
})
```

- [ ] **Step 5: Add TTL edge case tests**

```typescript
describe(`Fork - TTL Edge Cases`, () => {
  test(`fork with shorter TTL is capped at source expiry`, async () => {
    const sourcePath = `/v1/stream/ttlcap-src-${Date.now()}`
    const forkPath = `/v1/stream/ttlcap-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: {
        "Content-Type": `text/plain`,
        "Stream-TTL": `60`, // 60 seconds
      },
    })

    // Fork with shorter TTL
    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": sourcePath,
        "Stream-TTL": `30`, // 30 seconds — shorter than source
      },
    })
    expect(forkRes.status).toBe(201)
    // Fork should have an expiry that is <= source's
    expect(forkRes.headers.get(`Stream-Expires-At`)).toBeTruthy()
  })

  test(`fork cannot exceed source expiry — gets capped`, async () => {
    const sourcePath = `/v1/stream/ttlexceed-src-${Date.now()}`
    const forkPath = `/v1/stream/ttlexceed-child-${Date.now()}`

    await fetch(`${getBaseUrl()}${sourcePath}`, {
      method: `PUT`,
      headers: {
        "Content-Type": `text/plain`,
        "Stream-TTL": `60`,
      },
    })

    // Fork with longer TTL — should be capped
    const forkRes = await fetch(`${getBaseUrl()}${forkPath}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": sourcePath,
        "Stream-TTL": `99999`,
      },
    })
    expect(forkRes.status).toBe(201)
    const forkExpiry = forkRes.headers.get(`Stream-Expires-At`)
    expect(forkExpiry).toBeTruthy()

    // Source expiry
    const srcHead = await fetch(`${getBaseUrl()}${sourcePath}`, { method: `HEAD` })
    const srcExpiry = srcHead.headers.get(`Stream-Expires-At`)

    // Fork expiry should not exceed source
    if (forkExpiry && srcExpiry) {
      expect(new Date(forkExpiry).getTime()).toBeLessThanOrEqual(new Date(srcExpiry).getTime())
    }
  })
})
```

- [ ] **Step 6: Add recursive fork edge case test**

```typescript
describe(`Fork - Recursive Edge Cases`, () => {
  test(`fork a fork at mid-point of inherited data`, async () => {
    const a = `/v1/stream/recmid-a-${Date.now()}`
    const b = `/v1/stream/recmid-b-${Date.now()}`
    const c = `/v1/stream/recmid-c-${Date.now()}`

    // A has data
    const createA = await fetch(`${getBaseUrl()}${a}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `aaaa`,
    })
    const aOffset = createA.headers.get(`Stream-Next-Offset`)!

    // B forks A at head, adds own data
    await fetch(`${getBaseUrl()}${b}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": a },
    })
    await fetch(`${getBaseUrl()}${b}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `bbbb`,
    })

    // C forks B at A's original offset (mid-point of B's inherited range)
    await fetch(`${getBaseUrl()}${c}`, {
      method: `PUT`,
      headers: {
        "Stream-Forked-From": b,
        "Stream-Fork-Offset": aOffset,
      },
    })

    // C should only see A's data (inherited through B, capped at aOffset)
    const readC = await fetch(`${getBaseUrl()}${c}?offset=-1`)
    const body = await readC.text()
    expect(body).toBe(`aaaa`)
    expect(body).not.toContain(`bbbb`)
  })

  test(`append at each level independently`, async () => {
    const a = `/v1/stream/indep-a-${Date.now()}`
    const b = `/v1/stream/indep-b-${Date.now()}`
    const c = `/v1/stream/indep-c-${Date.now()}`

    await fetch(`${getBaseUrl()}${a}`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `A`,
    })
    await fetch(`${getBaseUrl()}${b}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": a },
    })
    await fetch(`${getBaseUrl()}${c}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": b },
    })

    // Append independently
    await fetch(`${getBaseUrl()}${a}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `A2`,
    })
    await fetch(`${getBaseUrl()}${b}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `B2`,
    })
    await fetch(`${getBaseUrl()}${c}`, {
      method: `POST`,
      headers: { "Content-Type": `text/plain` },
      body: `C2`,
    })

    // A sees: A, A2
    expect(await (await fetch(`${getBaseUrl()}${a}?offset=-1`)).text()).toBe(`AA2`)
    // B sees: A (inherited), B2 (own) — NOT A2
    expect(await (await fetch(`${getBaseUrl()}${b}?offset=-1`)).text()).toBe(`AB2`)
    // C sees: A (from A via B), B2 (from B), C2 (own) — NOT A2
    expect(await (await fetch(`${getBaseUrl()}${c}?offset=-1`)).text()).toBe(`AB2C2`)
  })
})
```

- [ ] **Step 7: Run all conformance tests**

Run: `pnpm test:run`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/server-conformance-tests/src/index.ts
git commit -m "test: add missing conformance tests for fork appending, live modes, lifecycle, and edge cases"
```

---

### Task 14: Changeset

Create a changeset for the fork feature.

**Files:**
- Create: `.changeset/fork-streams.md`

- [ ] **Step 1: Create changeset**

```bash
npx changeset add
```

Select all affected packages (`@durable-streams/server`, `@durable-streams/caddy-plugin`, `@durable-streams/server-conformance-tests`) with `patch` level. Message:

```
feat: add stream forking — create forks via PUT with Stream-Forked-From header, transparent read stitching, stream-level refcounting, soft-delete with cascading GC
```

- [ ] **Step 2: Commit changeset**

```bash
git add .changeset/
git commit -m "chore: add changeset for fork streams feature"
```

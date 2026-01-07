package store

import (
	"container/list"
	"os"
	"sync"
)

// FilePool manages a pool of file handles with LRU eviction
type FilePool struct {
	mu      sync.Mutex
	maxSize int
	files   map[string]*poolEntry
	lru     *list.List // LRU list, front = most recently used
}

type poolEntry struct {
	path    string
	file    *os.File
	element *list.Element
}

// NewFilePool creates a new file pool with the given maximum size
func NewFilePool(maxSize int) *FilePool {
	if maxSize <= 0 {
		maxSize = 100 // default
	}
	return &FilePool{
		maxSize: maxSize,
		files:   make(map[string]*poolEntry),
		lru:     list.New(),
	}
}

// GetWriter gets a file handle for writing (append mode)
// The returned file should not be closed by the caller
func (p *FilePool) GetWriter(path string) (*os.File, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Check if already open
	if entry, ok := p.files[path]; ok {
		// Move to front of LRU
		p.lru.MoveToFront(entry.element)
		return entry.file, nil
	}

	// Need to open
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}

	// Evict if needed
	p.evictIfNeeded()

	// Add to pool
	entry := &poolEntry{
		path: path,
		file: file,
	}
	entry.element = p.lru.PushFront(entry)
	p.files[path] = entry

	return file, nil
}

// Sync syncs a specific file to disk
func (p *FilePool) Sync(path string) error {
	p.mu.Lock()
	entry, ok := p.files[path]
	p.mu.Unlock()

	if !ok {
		return nil // Not open, nothing to sync
	}

	return entry.file.Sync()
}

// SyncAll syncs all open files to disk
func (p *FilePool) SyncAll() error {
	p.mu.Lock()
	entries := make([]*poolEntry, 0, len(p.files))
	for _, entry := range p.files {
		entries = append(entries, entry)
	}
	p.mu.Unlock()

	var lastErr error
	for _, entry := range entries {
		if err := entry.file.Sync(); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

// Remove removes a file from the pool and closes its handle
func (p *FilePool) Remove(path string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	entry, ok := p.files[path]
	if !ok {
		return nil
	}

	p.lru.Remove(entry.element)
	delete(p.files, path)
	return entry.file.Close()
}

// Close closes all file handles
func (p *FilePool) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	var lastErr error
	for path, entry := range p.files {
		if err := entry.file.Close(); err != nil {
			lastErr = err
		}
		delete(p.files, path)
	}
	p.lru.Init()

	return lastErr
}

// Size returns the number of open file handles
func (p *FilePool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.files)
}

// evictIfNeeded evicts the least recently used entry if the pool is full
// Must be called with lock held
func (p *FilePool) evictIfNeeded() {
	if len(p.files) < p.maxSize {
		return
	}

	// Evict from back of LRU (least recently used)
	elem := p.lru.Back()
	if elem == nil {
		return
	}

	entry := elem.Value.(*poolEntry)
	p.lru.Remove(elem)
	delete(p.files, entry.path)
	entry.file.Close()
}

// ReaderPool manages a pool of file handles for reading
type ReaderPool struct {
	mu      sync.Mutex
	maxSize int
	files   map[string]*readerEntry
	lru     *list.List
}

type readerEntry struct {
	path    string
	file    *os.File
	element *list.Element
}

// NewReaderPool creates a new reader pool
func NewReaderPool(maxSize int) *ReaderPool {
	if maxSize <= 0 {
		maxSize = 100
	}
	return &ReaderPool{
		maxSize: maxSize,
		files:   make(map[string]*readerEntry),
		lru:     list.New(),
	}
}

// GetReader gets a file handle for reading
func (p *ReaderPool) GetReader(path string) (*os.File, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if entry, ok := p.files[path]; ok {
		p.lru.MoveToFront(entry.element)
		return entry.file, nil
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	p.evictIfNeeded()

	entry := &readerEntry{
		path: path,
		file: file,
	}
	entry.element = p.lru.PushFront(entry)
	p.files[path] = entry

	return file, nil
}

// Remove removes a file from the pool
func (p *ReaderPool) Remove(path string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	entry, ok := p.files[path]
	if !ok {
		return nil
	}

	p.lru.Remove(entry.element)
	delete(p.files, path)
	return entry.file.Close()
}

// Close closes all file handles
func (p *ReaderPool) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	var lastErr error
	for path, entry := range p.files {
		if err := entry.file.Close(); err != nil {
			lastErr = err
		}
		delete(p.files, path)
	}
	p.lru.Init()

	return lastErr
}

// evictIfNeeded evicts the least recently used entry if needed
func (p *ReaderPool) evictIfNeeded() {
	if len(p.files) < p.maxSize {
		return
	}

	elem := p.lru.Back()
	if elem == nil {
		return
	}

	entry := elem.Value.(*readerEntry)
	p.lru.Remove(elem)
	delete(p.files, entry.path)
	entry.file.Close()
}

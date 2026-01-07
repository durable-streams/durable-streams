package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.etcd.io/bbolt"
)

// BboltMetadataStore stores stream metadata in bbolt
type BboltMetadataStore struct {
	db     *bbolt.DB
	mu     sync.RWMutex
	path   string
	closed bool
}

// bboltMetadata is the serialized form of StreamMetadata
type bboltMetadata struct {
	Path          string `json:"path"`
	ContentType   string `json:"content_type"`
	CurrentOffset string `json:"current_offset"` // Offset as string for easy serialization
	LastSeq       string `json:"last_seq"`
	TTLSeconds    *int64 `json:"ttl_seconds,omitempty"`
	ExpiresAt     *int64 `json:"expires_at,omitempty"` // Unix timestamp
	CreatedAt     int64  `json:"created_at"`           // Unix timestamp
	DirectoryName string `json:"directory_name"`
}

var metadataBucket = []byte("metadata")

// NewBboltMetadataStore creates a new bbolt-backed metadata store
func NewBboltMetadataStore(dataDir string) (*BboltMetadataStore, error) {
	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	// Open bbolt database
	dbPath := filepath.Join(dataDir, "metadata.db")
	db, err := bbolt.Open(dbPath, 0600, &bbolt.Options{
		Timeout: 1 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to open bbolt database: %w", err)
	}

	// Create the metadata bucket if it doesn't exist
	err = db.Update(func(tx *bbolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(metadataBucket)
		return err
	})
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to create metadata bucket: %w", err)
	}

	return &BboltMetadataStore{
		db:   db,
		path: dataDir,
	}, nil
}

// Put stores metadata for a stream
func (s *BboltMetadataStore) Put(meta *StreamMetadata, directoryName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	// Convert to serializable form
	bm := bboltMetadata{
		Path:          meta.Path,
		ContentType:   meta.ContentType,
		CurrentOffset: meta.CurrentOffset.String(),
		LastSeq:       meta.LastSeq,
		TTLSeconds:    meta.TTLSeconds,
		CreatedAt:     meta.CreatedAt.Unix(),
		DirectoryName: directoryName,
	}
	if meta.ExpiresAt != nil {
		ts := meta.ExpiresAt.Unix()
		bm.ExpiresAt = &ts
	}

	data, err := json.Marshal(bm)
	if err != nil {
		return fmt.Errorf("failed to marshal metadata: %w", err)
	}

	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		return b.Put([]byte(meta.Path), data)
	})
}

// Get retrieves metadata for a stream
func (s *BboltMetadataStore) Get(path string) (*StreamMetadata, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return nil, "", fmt.Errorf("store is closed")
	}

	var meta *StreamMetadata
	var directoryName string

	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		data := b.Get([]byte(path))
		if data == nil {
			return ErrStreamNotFound
		}

		// Make a copy of the data since it's only valid during transaction
		dataCopy := make([]byte, len(data))
		copy(dataCopy, data)

		var bm bboltMetadata
		if err := json.Unmarshal(dataCopy, &bm); err != nil {
			return fmt.Errorf("failed to unmarshal metadata: %w", err)
		}

		offset, err := ParseOffset(bm.CurrentOffset)
		if err != nil {
			return fmt.Errorf("failed to parse offset: %w", err)
		}

		meta = &StreamMetadata{
			Path:          bm.Path,
			ContentType:   bm.ContentType,
			CurrentOffset: offset,
			LastSeq:       bm.LastSeq,
			TTLSeconds:    bm.TTLSeconds,
		}

		if bm.ExpiresAt != nil {
			t := timeFromUnix(*bm.ExpiresAt)
			meta.ExpiresAt = &t
		}
		meta.CreatedAt = timeFromUnix(bm.CreatedAt)
		directoryName = bm.DirectoryName

		return nil
	})

	if err != nil {
		return nil, "", err
	}
	return meta, directoryName, nil
}

// Has checks if a stream exists
func (s *BboltMetadataStore) Has(path string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return false
	}

	exists := false
	s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		exists = b.Get([]byte(path)) != nil
		return nil
	})
	return exists
}

// Delete removes metadata for a stream
func (s *BboltMetadataStore) Delete(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		if b.Get([]byte(path)) == nil {
			return ErrStreamNotFound
		}
		return b.Delete([]byte(path))
	})
}

// UpdateOffset updates only the offset for a stream
func (s *BboltMetadataStore) UpdateOffset(path string, offset Offset, lastSeq string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)

		// Read existing
		data := b.Get([]byte(path))
		if data == nil {
			return ErrStreamNotFound
		}

		// Make a copy
		dataCopy := make([]byte, len(data))
		copy(dataCopy, data)

		var bm bboltMetadata
		if err := json.Unmarshal(dataCopy, &bm); err != nil {
			return err
		}

		// Update offset and seq
		bm.CurrentOffset = offset.String()
		if lastSeq != "" {
			bm.LastSeq = lastSeq
		}

		// Write back
		newData, err := json.Marshal(bm)
		if err != nil {
			return err
		}

		return b.Put([]byte(path), newData)
	})
}

// List returns all stream paths
func (s *BboltMetadataStore) List() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return nil, fmt.Errorf("store is closed")
	}

	var paths []string
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		return b.ForEach(func(k, v []byte) error {
			// Make a copy of the key
			pathCopy := make([]byte, len(k))
			copy(pathCopy, k)
			paths = append(paths, string(pathCopy))
			return nil
		})
	})

	return paths, err
}

// ForEach iterates over all streams
func (s *BboltMetadataStore) ForEach(fn func(meta *StreamMetadata, directoryName string) error) error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	return s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(metadataBucket)
		return b.ForEach(func(k, v []byte) error {
			// Make a copy
			dataCopy := make([]byte, len(v))
			copy(dataCopy, v)

			var bm bboltMetadata
			if err := json.Unmarshal(dataCopy, &bm); err != nil {
				return err
			}

			offset, err := ParseOffset(bm.CurrentOffset)
			if err != nil {
				return err
			}

			meta := &StreamMetadata{
				Path:          bm.Path,
				ContentType:   bm.ContentType,
				CurrentOffset: offset,
				LastSeq:       bm.LastSeq,
				TTLSeconds:    bm.TTLSeconds,
			}
			if bm.ExpiresAt != nil {
				t := timeFromUnix(*bm.ExpiresAt)
				meta.ExpiresAt = &t
			}
			meta.CreatedAt = timeFromUnix(bm.CreatedAt)

			return fn(meta, bm.DirectoryName)
		})
	})
}

// Close closes the bbolt database
func (s *BboltMetadataStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return nil
	}
	s.closed = true
	return s.db.Close()
}

// Sync forces a sync of the bbolt database to disk
func (s *BboltMetadataStore) Sync() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	return s.db.Sync()
}

// Path returns the path to the bbolt database
func (s *BboltMetadataStore) Path() string {
	return s.path
}

// timeFromUnix converts a Unix timestamp to time.Time
func timeFromUnix(ts int64) (t time.Time) {
	return time.Unix(ts, 0)
}

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
	// Idempotent producer state (added in protocol v1.1)
	Producers map[string]*bboltProducerState `json:"producers,omitempty"`
	// Stream closure state
	Closed   bool                   `json:"closed,omitempty"`
	ClosedBy *bboltClosedByProducer `json:"closed_by,omitempty"`
}

// bboltClosedByProducer is the serialized form of ClosedByProducer
type bboltClosedByProducer struct {
	ProducerId string `json:"producer_id"`
	Epoch      int64  `json:"epoch"`
	Seq        int64  `json:"seq"`
}

// bboltProducerState is the serialized form of ProducerState
type bboltProducerState struct {
	Epoch       int64 `json:"epoch"`
	LastSeq     int64 `json:"last_seq"`
	LastUpdated int64 `json:"last_updated"`
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
		Closed:        meta.Closed,
	}
	if meta.ExpiresAt != nil {
		ts := meta.ExpiresAt.Unix()
		bm.ExpiresAt = &ts
	}

	// Convert producers map
	if meta.Producers != nil && len(meta.Producers) > 0 {
		bm.Producers = make(map[string]*bboltProducerState, len(meta.Producers))
		for id, state := range meta.Producers {
			bm.Producers[id] = &bboltProducerState{
				Epoch:       state.Epoch,
				LastSeq:     state.LastSeq,
				LastUpdated: state.LastUpdated,
			}
		}
	}

	// Convert ClosedBy
	if meta.ClosedBy != nil {
		bm.ClosedBy = &bboltClosedByProducer{
			ProducerId: meta.ClosedBy.ProducerId,
			Epoch:      meta.ClosedBy.Epoch,
			Seq:        meta.ClosedBy.Seq,
		}
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
			Closed:        bm.Closed,
		}

		if bm.ExpiresAt != nil {
			t := timeFromUnix(*bm.ExpiresAt)
			meta.ExpiresAt = &t
		}
		meta.CreatedAt = timeFromUnix(bm.CreatedAt)
		directoryName = bm.DirectoryName

		// Deserialize producers
		if bm.Producers != nil && len(bm.Producers) > 0 {
			meta.Producers = make(map[string]*ProducerState, len(bm.Producers))
			for id, state := range bm.Producers {
				meta.Producers[id] = &ProducerState{
					Epoch:       state.Epoch,
					LastSeq:     state.LastSeq,
					LastUpdated: state.LastUpdated,
				}
			}
		}

		// Deserialize ClosedBy
		if bm.ClosedBy != nil {
			meta.ClosedBy = &ClosedByProducer{
				ProducerId: bm.ClosedBy.ProducerId,
				Epoch:      bm.ClosedBy.Epoch,
				Seq:        bm.ClosedBy.Seq,
			}
		}

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

// UpdateAppendState updates offset, lastSeq, producer state, and optionally closed state atomically
func (s *BboltMetadataStore) UpdateAppendState(path string, offset Offset, lastSeq string, producerId string, producerState *ProducerState, closed bool, closedBy *ClosedByProducer) error {
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

		// Update producer state
		if producerId != "" && producerState != nil {
			if bm.Producers == nil {
				bm.Producers = make(map[string]*bboltProducerState)
			}
			bm.Producers[producerId] = &bboltProducerState{
				Epoch:       producerState.Epoch,
				LastSeq:     producerState.LastSeq,
				LastUpdated: producerState.LastUpdated,
			}
		}

		// Update closed state if requested
		if closed {
			bm.Closed = true
			if closedBy != nil {
				bm.ClosedBy = &bboltClosedByProducer{
					ProducerId: closedBy.ProducerId,
					Epoch:      closedBy.Epoch,
					Seq:        closedBy.Seq,
				}
			}
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
				Closed:        bm.Closed,
			}
			if bm.ExpiresAt != nil {
				t := timeFromUnix(*bm.ExpiresAt)
				meta.ExpiresAt = &t
			}
			meta.CreatedAt = timeFromUnix(bm.CreatedAt)

			// Deserialize producers
			if bm.Producers != nil && len(bm.Producers) > 0 {
				meta.Producers = make(map[string]*ProducerState, len(bm.Producers))
				for id, state := range bm.Producers {
					meta.Producers[id] = &ProducerState{
						Epoch:       state.Epoch,
						LastSeq:     state.LastSeq,
						LastUpdated: state.LastUpdated,
					}
				}
			}

			// Deserialize ClosedBy
			if bm.ClosedBy != nil {
				meta.ClosedBy = &ClosedByProducer{
					ProducerId: bm.ClosedBy.ProducerId,
					Epoch:      bm.ClosedBy.Epoch,
					Seq:        bm.ClosedBy.Seq,
				}
			}

			return fn(meta, bm.DirectoryName)
		})
	})
}

// SetClosed updates only the closed state for a stream
func (s *BboltMetadataStore) SetClosed(path string, closed bool, closedBy *ClosedByProducer) error {
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

		// Update closed state
		bm.Closed = closed
		if closedBy != nil {
			bm.ClosedBy = &bboltClosedByProducer{
				ProducerId: closedBy.ProducerId,
				Epoch:      closedBy.Epoch,
				Seq:        closedBy.Seq,
			}
		}

		// Write back
		newData, err := json.Marshal(bm)
		if err != nil {
			return err
		}

		return b.Put([]byte(path), newData)
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

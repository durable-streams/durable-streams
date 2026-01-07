package store

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// Segment file format:
// Each message is stored as:
//   [4-byte big-endian length][data bytes]
// Messages are concatenated without separators.
//
// For JSON mode, each JSON value is stored as a separate message.
// For binary mode, all data is stored as a single message.

const (
	// SegmentFileName is the name of the segment file within a stream directory
	SegmentFileName = "data.seg"

	// LengthPrefixSize is the size of the length prefix in bytes
	LengthPrefixSize = 4

	// MaxMessageSize is the maximum allowed message size (64MB)
	MaxMessageSize = 64 * 1024 * 1024
)

var (
	// ErrMessageTooLarge is returned when a message exceeds MaxMessageSize
	ErrMessageTooLarge = errors.New("message too large")

	// ErrCorruptedSegment is returned when segment file appears corrupted
	ErrCorruptedSegment = errors.New("corrupted segment file")
)

// WriteMessage writes a single message to the segment file
// Returns the number of bytes written (including length prefix)
func WriteMessage(w io.Writer, data []byte) (int, error) {
	if len(data) > MaxMessageSize {
		return 0, ErrMessageTooLarge
	}

	// Write length prefix
	var lenBuf [LengthPrefixSize]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(data)))

	n, err := w.Write(lenBuf[:])
	if err != nil {
		return n, err
	}

	// Write data
	n2, err := w.Write(data)
	return n + n2, err
}

// ReadMessage reads a single message from the segment file
// Returns the message data and any error
func ReadMessage(r io.Reader) ([]byte, error) {
	// Read length prefix
	var lenBuf [LengthPrefixSize]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}

	length := binary.BigEndian.Uint32(lenBuf[:])
	if length > MaxMessageSize {
		return nil, ErrCorruptedSegment
	}

	// Read data
	data := make([]byte, length)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, err
	}

	return data, nil
}

// SegmentReader reads messages from a segment file
type SegmentReader struct {
	file    *os.File
	reader  *bufio.Reader
	offset  uint64 // current byte offset in file
	readSeq uint64 // current read sequence (for offset calculation)
}

// NewSegmentReader creates a new segment reader
func NewSegmentReader(path string) (*SegmentReader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	return &SegmentReader{
		file:   file,
		reader: bufio.NewReaderSize(file, 64*1024), // 64KB buffer
	}, nil
}

// SeekToOffset seeks to a position in the file based on byte offset
func (r *SegmentReader) SeekToOffset(byteOffset uint64) error {
	// Reset the buffered reader
	if _, err := r.file.Seek(int64(byteOffset), io.SeekStart); err != nil {
		return err
	}
	r.reader.Reset(r.file)
	r.offset = byteOffset
	return nil
}

// ReadMessages reads all messages starting from the given offset
// Returns messages and the final offset
func (r *SegmentReader) ReadMessages(startOffset Offset) ([]Message, Offset, error) {
	// Seek to the starting byte offset
	if err := r.SeekToOffset(startOffset.ByteOffset); err != nil {
		return nil, startOffset, err
	}

	var messages []Message
	currentOffset := startOffset

	for {
		data, err := ReadMessage(r.reader)
		if err == io.EOF {
			break
		}
		if err != nil {
			return messages, currentOffset, err
		}

		// Calculate new offset
		bytesRead := uint64(LengthPrefixSize + len(data))
		newOffset := Offset{
			ReadSeq:    currentOffset.ReadSeq,
			ByteOffset: currentOffset.ByteOffset + bytesRead,
		}

		messages = append(messages, Message{
			Data:   data,
			Offset: newOffset,
		})

		currentOffset = newOffset
	}

	return messages, currentOffset, nil
}

// Close closes the segment reader
func (r *SegmentReader) Close() error {
	return r.file.Close()
}

// SegmentWriter writes messages to a segment file
type SegmentWriter struct {
	file   *os.File
	offset uint64
}

// NewSegmentWriter creates or opens a segment file for writing
func NewSegmentWriter(path string) (*SegmentWriter, error) {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}

	// Get current file size for offset tracking
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}

	return &SegmentWriter{
		file:   file,
		offset: uint64(info.Size()),
	}, nil
}

// WriteMessage writes a message and returns the new offset
func (w *SegmentWriter) WriteMessage(data []byte) (Offset, error) {
	n, err := WriteMessage(w.file, data)
	if err != nil {
		return Offset{}, err
	}

	w.offset += uint64(n)
	return Offset{
		ReadSeq:    0, // ReadSeq stays 0 for simple byte-offset based storage
		ByteOffset: w.offset,
	}, nil
}

// WriteMessages writes multiple messages and returns the final offset
func (w *SegmentWriter) WriteMessages(messages [][]byte) (Offset, error) {
	for _, data := range messages {
		_, err := WriteMessage(w.file, data)
		if err != nil {
			return Offset{}, err
		}
		w.offset += uint64(LengthPrefixSize + len(data))
	}

	return Offset{
		ReadSeq:    0,
		ByteOffset: w.offset,
	}, nil
}

// Sync syncs the file to disk
func (w *SegmentWriter) Sync() error {
	return w.file.Sync()
}

// Close closes the segment writer
func (w *SegmentWriter) Close() error {
	return w.file.Close()
}

// CurrentOffset returns the current write offset
func (w *SegmentWriter) CurrentOffset() Offset {
	return Offset{
		ReadSeq:    0,
		ByteOffset: w.offset,
	}
}

// ScanSegment scans a segment file and returns the final offset
// This is used for recovery to determine the true offset after crash
func ScanSegment(path string) (Offset, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ZeroOffset, nil
		}
		return Offset{}, err
	}
	defer file.Close()

	reader := bufio.NewReader(file)
	var offset uint64

	for {
		// Read length prefix
		var lenBuf [LengthPrefixSize]byte
		_, err := io.ReadFull(reader, lenBuf[:])
		if err == io.EOF {
			break
		}
		if err != nil {
			// Partial read - truncated file
			break
		}

		length := binary.BigEndian.Uint32(lenBuf[:])
		if length > MaxMessageSize {
			// Corrupted - stop here
			break
		}

		// Skip the data
		skipped, err := reader.Discard(int(length))
		if err != nil {
			// Partial message - truncated
			break
		}
		if uint32(skipped) != length {
			// Partial message
			break
		}

		// Update offset
		offset += uint64(LengthPrefixSize) + uint64(length)
	}

	return Offset{ReadSeq: 0, ByteOffset: offset}, nil
}

// CreateSegmentFile creates an empty segment file
func CreateSegmentFile(path string) error {
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("failed to create segment file: %w", err)
	}
	return file.Close()
}

// SegmentFileSize returns the size of a segment file
func SegmentFileSize(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

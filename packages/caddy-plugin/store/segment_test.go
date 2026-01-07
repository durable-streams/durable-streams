package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteReadMessage(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{"empty", []byte{}},
		{"simple", []byte("hello world")},
		{"binary", []byte{0x00, 0x01, 0x02, 0xff, 0xfe}},
		{"large", bytes.Repeat([]byte("x"), 1024*1024)}, // 1MB
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer

			// Write
			n, err := WriteMessage(&buf, tt.data)
			if err != nil {
				t.Fatalf("WriteMessage failed: %v", err)
			}
			expectedSize := LengthPrefixSize + len(tt.data)
			if n != expectedSize {
				t.Errorf("wrote %d bytes, expected %d", n, expectedSize)
			}

			// Read
			data, err := ReadMessage(&buf)
			if err != nil {
				t.Fatalf("ReadMessage failed: %v", err)
			}
			if !bytes.Equal(data, tt.data) {
				t.Errorf("data mismatch: got %d bytes, want %d bytes", len(data), len(tt.data))
			}
		})
	}
}

func TestSegmentWriter(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	// Create writer
	writer, err := NewSegmentWriter(segPath)
	if err != nil {
		t.Fatalf("failed to create writer: %v", err)
	}

	// Write some messages
	messages := [][]byte{
		[]byte(`{"id": 1}`),
		[]byte(`{"id": 2}`),
		[]byte(`{"id": 3}`),
	}

	var lastOffset Offset
	for _, msg := range messages {
		offset, err := writer.WriteMessage(msg)
		if err != nil {
			t.Fatalf("WriteMessage failed: %v", err)
		}
		lastOffset = offset
	}

	if err := writer.Sync(); err != nil {
		t.Fatalf("Sync failed: %v", err)
	}
	writer.Close()

	// Verify offset
	expectedBytes := uint64(0)
	for _, msg := range messages {
		expectedBytes += uint64(LengthPrefixSize + len(msg))
	}
	if lastOffset.ByteOffset != expectedBytes {
		t.Errorf("offset mismatch: got %d, want %d", lastOffset.ByteOffset, expectedBytes)
	}
}

func TestSegmentReader(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	// Write some messages
	messages := [][]byte{
		[]byte(`{"id": 1}`),
		[]byte(`{"id": 2}`),
		[]byte(`{"id": 3}`),
	}

	writer, err := NewSegmentWriter(segPath)
	if err != nil {
		t.Fatalf("failed to create writer: %v", err)
	}
	for _, msg := range messages {
		if _, err := writer.WriteMessage(msg); err != nil {
			t.Fatalf("WriteMessage failed: %v", err)
		}
	}
	writer.Close()

	// Read all messages
	reader, err := NewSegmentReader(segPath)
	if err != nil {
		t.Fatalf("failed to create reader: %v", err)
	}
	defer reader.Close()

	readMsgs, finalOffset, err := reader.ReadMessages(ZeroOffset)
	if err != nil {
		t.Fatalf("ReadMessages failed: %v", err)
	}

	if len(readMsgs) != len(messages) {
		t.Errorf("read %d messages, want %d", len(readMsgs), len(messages))
	}

	for i, msg := range readMsgs {
		if !bytes.Equal(msg.Data, messages[i]) {
			t.Errorf("message %d mismatch", i)
		}
	}

	// Final offset should match what we calculated
	expectedBytes := uint64(0)
	for _, msg := range messages {
		expectedBytes += uint64(LengthPrefixSize + len(msg))
	}
	if finalOffset.ByteOffset != expectedBytes {
		t.Errorf("final offset mismatch: got %d, want %d", finalOffset.ByteOffset, expectedBytes)
	}
}

func TestSegmentReaderFromOffset(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	// Write messages
	messages := [][]byte{
		[]byte(`{"id": 1}`),
		[]byte(`{"id": 2}`),
		[]byte(`{"id": 3}`),
	}

	writer, err := NewSegmentWriter(segPath)
	if err != nil {
		t.Fatalf("failed to create writer: %v", err)
	}

	var offsets []Offset
	offsets = append(offsets, ZeroOffset)
	for _, msg := range messages {
		offset, _ := writer.WriteMessage(msg)
		offsets = append(offsets, offset)
	}
	writer.Close()

	// Read from middle offset (after first message)
	reader, err := NewSegmentReader(segPath)
	if err != nil {
		t.Fatalf("failed to create reader: %v", err)
	}
	defer reader.Close()

	readMsgs, _, err := reader.ReadMessages(offsets[1])
	if err != nil {
		t.Fatalf("ReadMessages failed: %v", err)
	}

	// Should get messages 2 and 3
	if len(readMsgs) != 2 {
		t.Errorf("read %d messages, want 2", len(readMsgs))
	}
	if !bytes.Equal(readMsgs[0].Data, messages[1]) {
		t.Errorf("first message mismatch")
	}
	if !bytes.Equal(readMsgs[1].Data, messages[2]) {
		t.Errorf("second message mismatch")
	}
}

func TestScanSegment(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	// Write messages
	messages := [][]byte{
		[]byte(`{"id": 1}`),
		[]byte(`{"id": 2}`),
	}

	writer, err := NewSegmentWriter(segPath)
	if err != nil {
		t.Fatalf("failed to create writer: %v", err)
	}
	finalOffset, _ := writer.WriteMessages(messages)
	writer.Close()

	// Scan should return same offset
	scannedOffset, err := ScanSegment(segPath)
	if err != nil {
		t.Fatalf("ScanSegment failed: %v", err)
	}

	if !scannedOffset.Equal(finalOffset) {
		t.Errorf("scanned offset %v != written offset %v", scannedOffset, finalOffset)
	}
}

func TestScanSegmentNonExistent(t *testing.T) {
	offset, err := ScanSegment("/nonexistent/path/data.seg")
	if err != nil {
		t.Fatalf("ScanSegment should not error for nonexistent: %v", err)
	}
	if !offset.Equal(ZeroOffset) {
		t.Errorf("expected zero offset for nonexistent, got %v", offset)
	}
}

func TestScanSegmentTruncated(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	// Write a complete message
	writer, err := NewSegmentWriter(segPath)
	if err != nil {
		t.Fatalf("failed to create writer: %v", err)
	}
	completeOffset, _ := writer.WriteMessage([]byte(`{"complete": true}`))
	writer.Close()

	// Append a partial message (just length prefix, no data)
	file, _ := os.OpenFile(segPath, os.O_APPEND|os.O_WRONLY, 0644)
	file.Write([]byte{0x00, 0x00, 0x00, 0x10}) // Says 16 bytes follow
	file.Close()

	// Scan should return offset of complete messages only
	scannedOffset, err := ScanSegment(segPath)
	if err != nil {
		t.Fatalf("ScanSegment failed: %v", err)
	}

	if !scannedOffset.Equal(completeOffset) {
		t.Errorf("scanned offset %v != complete offset %v", scannedOffset, completeOffset)
	}
}

func TestWriteMessagesMultiple(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	writer, err := NewSegmentWriter(segPath)
	if err != nil {
		t.Fatalf("failed to create writer: %v", err)
	}

	messages := [][]byte{
		[]byte(`1`),
		[]byte(`2`),
		[]byte(`3`),
	}

	offset, err := writer.WriteMessages(messages)
	if err != nil {
		t.Fatalf("WriteMessages failed: %v", err)
	}
	writer.Close()

	// Calculate expected
	expectedBytes := uint64(0)
	for _, msg := range messages {
		expectedBytes += uint64(LengthPrefixSize + len(msg))
	}
	if offset.ByteOffset != expectedBytes {
		t.Errorf("offset %d != expected %d", offset.ByteOffset, expectedBytes)
	}

	// Read back
	reader, err := NewSegmentReader(segPath)
	if err != nil {
		t.Fatalf("failed to create reader: %v", err)
	}
	defer reader.Close()

	readMsgs, _, err := reader.ReadMessages(ZeroOffset)
	if err != nil {
		t.Fatalf("ReadMessages failed: %v", err)
	}

	if len(readMsgs) != 3 {
		t.Errorf("read %d messages, want 3", len(readMsgs))
	}
}

func TestMessageTooLarge(t *testing.T) {
	var buf bytes.Buffer
	largeData := make([]byte, MaxMessageSize+1)

	_, err := WriteMessage(&buf, largeData)
	if err != ErrMessageTooLarge {
		t.Errorf("expected ErrMessageTooLarge, got %v", err)
	}
}

func TestCreateSegmentFile(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	if err := CreateSegmentFile(segPath); err != nil {
		t.Fatalf("CreateSegmentFile failed: %v", err)
	}

	// Should exist and be empty
	size, err := SegmentFileSize(segPath)
	if err != nil {
		t.Fatalf("SegmentFileSize failed: %v", err)
	}
	if size != 0 {
		t.Errorf("expected empty file, got size %d", size)
	}
}

func TestSegmentWriterAppend(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "segment-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segPath := filepath.Join(tmpDir, "test.seg")

	// Write first batch
	writer1, _ := NewSegmentWriter(segPath)
	writer1.WriteMessage([]byte(`1`))
	writer1.Close()

	// Write second batch (should append)
	writer2, _ := NewSegmentWriter(segPath)
	if writer2.CurrentOffset().ByteOffset == 0 {
		t.Error("second writer should start at non-zero offset")
	}
	writer2.WriteMessage([]byte(`2`))
	writer2.Close()

	// Read back
	reader, _ := NewSegmentReader(segPath)
	defer reader.Close()

	msgs, _, _ := reader.ReadMessages(ZeroOffset)
	if len(msgs) != 2 {
		t.Errorf("expected 2 messages, got %d", len(msgs))
	}
}

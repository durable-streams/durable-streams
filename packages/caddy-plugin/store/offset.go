package store

import (
	"fmt"
	"strconv"
	"strings"
)

// Offset represents a position within a stream.
// Format: "0000000000000000_0000000000000000" (16 digits each, zero-padded)
// The format is lexicographically sortable.
type Offset struct {
	ReadSeq    uint64 // For future log rotation support
	ByteOffset uint64 // Bytes of actual data (not framing)
}

// ZeroOffset is the starting offset for a new stream
var ZeroOffset = Offset{ReadSeq: 0, ByteOffset: 0}

// String returns the offset as a formatted string.
// Format: "%016d_%016d"
func (o Offset) String() string {
	return fmt.Sprintf("%016d_%016d", o.ReadSeq, o.ByteOffset)
}

// IsZero returns true if this is the zero/starting offset
func (o Offset) IsZero() bool {
	return o.ReadSeq == 0 && o.ByteOffset == 0
}

// Add returns a new offset with the given byte count added
func (o Offset) Add(bytes uint64) Offset {
	return Offset{
		ReadSeq:    o.ReadSeq,
		ByteOffset: o.ByteOffset + bytes,
	}
}

// ParseOffset parses an offset string.
// Special case: "-1" returns ZeroOffset (meaning "start from beginning")
// Returns error for invalid formats.
func ParseOffset(s string) (Offset, error) {
	// Handle empty string as zero offset
	if s == "" {
		return ZeroOffset, nil
	}

	// Handle "-1" as "start from beginning"
	if s == "-1" {
		return ZeroOffset, nil
	}

	// Strict validation: offset must only contain digits and exactly one underscore
	// This prevents injection attacks and malformed inputs
	if !isValidOffsetFormat(s) {
		return Offset{}, fmt.Errorf("invalid offset format: must be 'digits_digits'")
	}

	// Parse format: "readseq_byteoffset"
	parts := strings.Split(s, "_")
	if len(parts) != 2 {
		return Offset{}, fmt.Errorf("invalid offset format: expected 'readseq_byteoffset'")
	}

	readSeq, err := strconv.ParseUint(parts[0], 10, 64)
	if err != nil {
		return Offset{}, fmt.Errorf("invalid offset: readseq not a number: %w", err)
	}

	byteOffset, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil {
		return Offset{}, fmt.Errorf("invalid offset: byteoffset not a number: %w", err)
	}

	return Offset{ReadSeq: readSeq, ByteOffset: byteOffset}, nil
}

// isValidOffsetFormat checks if the string matches the valid offset format
// Valid format: one or more digits, underscore, one or more digits
// No spaces, special characters, control characters, etc.
func isValidOffsetFormat(s string) bool {
	if len(s) < 3 { // minimum: "0_0"
		return false
	}

	underscoreCount := 0
	underscorePos := -1

	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '_' {
			underscoreCount++
			underscorePos = i
			if underscoreCount > 1 {
				return false
			}
		} else if c < '0' || c > '9' {
			// Not a digit
			return false
		}
	}

	// Must have exactly one underscore, not at start or end
	return underscoreCount == 1 && underscorePos > 0 && underscorePos < len(s)-1
}

// Compare compares two offsets.
// Returns -1 if a < b, 0 if a == b, 1 if a > b.
func Compare(a, b Offset) int {
	if a.ReadSeq < b.ReadSeq {
		return -1
	}
	if a.ReadSeq > b.ReadSeq {
		return 1
	}
	if a.ByteOffset < b.ByteOffset {
		return -1
	}
	if a.ByteOffset > b.ByteOffset {
		return 1
	}
	return 0
}

// LessThan returns true if a < b
func (o Offset) LessThan(other Offset) bool {
	return Compare(o, other) < 0
}

// LessThanOrEqual returns true if a <= b
func (o Offset) LessThanOrEqual(other Offset) bool {
	return Compare(o, other) <= 0
}

// Equal returns true if a == b
func (o Offset) Equal(other Offset) bool {
	return Compare(o, other) == 0
}

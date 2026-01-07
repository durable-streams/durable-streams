package store

import (
	"testing"
)

func TestOffsetString(t *testing.T) {
	tests := []struct {
		name     string
		offset   Offset
		expected string
	}{
		{
			name:     "zero offset",
			offset:   Offset{ReadSeq: 0, ByteOffset: 0},
			expected: "0000000000000000_0000000000000000",
		},
		{
			name:     "simple offset",
			offset:   Offset{ReadSeq: 0, ByteOffset: 11},
			expected: "0000000000000000_0000000000000011",
		},
		{
			name:     "large offset",
			offset:   Offset{ReadSeq: 1, ByteOffset: 1234567890},
			expected: "0000000000000001_0000001234567890",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := tt.offset.String()
			if result != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, result)
			}
		})
	}
}

func TestParseOffset(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		expected    Offset
		expectError bool
	}{
		{
			name:     "empty string",
			input:    "",
			expected: ZeroOffset,
		},
		{
			name:     "minus one",
			input:    "-1",
			expected: ZeroOffset,
		},
		{
			name:     "zero offset string",
			input:    "0000000000000000_0000000000000000",
			expected: Offset{ReadSeq: 0, ByteOffset: 0},
		},
		{
			name:     "simple offset",
			input:    "0000000000000000_0000000000000011",
			expected: Offset{ReadSeq: 0, ByteOffset: 11},
		},
		{
			name:     "non-padded also works",
			input:    "0_11",
			expected: Offset{ReadSeq: 0, ByteOffset: 11},
		},
		{
			name:        "invalid - comma",
			input:       "0,11",
			expectError: true,
		},
		{
			name:        "invalid - ampersand",
			input:       "0&11",
			expectError: true,
		},
		{
			name:        "invalid - equals",
			input:       "0=11",
			expectError: true,
		},
		{
			name:        "invalid - question mark",
			input:       "0?11",
			expectError: true,
		},
		{
			name:        "invalid - no underscore",
			input:       "12345",
			expectError: true,
		},
		{
			name:        "invalid - not a number",
			input:       "abc_def",
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseOffset(tt.input)
			if tt.expectError {
				if err == nil {
					t.Errorf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Errorf("unexpected error: %v", err)
				return
			}
			if result != tt.expected {
				t.Errorf("expected %+v, got %+v", tt.expected, result)
			}
		})
	}
}

func TestOffsetRoundTrip(t *testing.T) {
	original := Offset{ReadSeq: 42, ByteOffset: 12345}
	str := original.String()
	parsed, err := ParseOffset(str)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if parsed != original {
		t.Errorf("round trip failed: expected %+v, got %+v", original, parsed)
	}
}

func TestOffsetCompare(t *testing.T) {
	tests := []struct {
		name     string
		a, b     Offset
		expected int
	}{
		{
			name:     "equal",
			a:        Offset{0, 0},
			b:        Offset{0, 0},
			expected: 0,
		},
		{
			name:     "a < b by byte offset",
			a:        Offset{0, 10},
			b:        Offset{0, 20},
			expected: -1,
		},
		{
			name:     "a > b by byte offset",
			a:        Offset{0, 20},
			b:        Offset{0, 10},
			expected: 1,
		},
		{
			name:     "a < b by read seq",
			a:        Offset{0, 100},
			b:        Offset{1, 0},
			expected: -1,
		},
		{
			name:     "a > b by read seq",
			a:        Offset{2, 0},
			b:        Offset{1, 1000},
			expected: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := Compare(tt.a, tt.b)
			if result != tt.expected {
				t.Errorf("expected %d, got %d", tt.expected, result)
			}
		})
	}
}

func TestOffsetLexicographicOrder(t *testing.T) {
	// Verify that string comparison matches semantic comparison
	offsets := []Offset{
		{0, 0},
		{0, 1},
		{0, 10},
		{0, 100},
		{1, 0},
		{1, 50},
	}

	for i := 0; i < len(offsets)-1; i++ {
		a := offsets[i]
		b := offsets[i+1]
		strA := a.String()
		strB := b.String()

		// Semantic comparison should say a < b
		if Compare(a, b) >= 0 {
			t.Errorf("expected %+v < %+v", a, b)
		}

		// String comparison should also say a < b
		if strA >= strB {
			t.Errorf("expected %q < %q (lexicographic)", strA, strB)
		}
	}
}

func TestOffsetAdd(t *testing.T) {
	o := Offset{ReadSeq: 1, ByteOffset: 100}
	result := o.Add(50)

	if result.ReadSeq != 1 {
		t.Errorf("expected ReadSeq 1, got %d", result.ReadSeq)
	}
	if result.ByteOffset != 150 {
		t.Errorf("expected ByteOffset 150, got %d", result.ByteOffset)
	}
}

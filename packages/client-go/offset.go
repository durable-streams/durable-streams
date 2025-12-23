package durablestreams

// Offset is an opaque position token in a stream.
//
// Offsets are:
//   - Opaque: Do not parse or interpret offset structure
//   - Lexicographically sortable: Compare offsets to determine ordering
//   - Persistent: Valid for the stream's lifetime
//   - Unique: Each position has exactly one offset
//
// Use StartOffset to read from the beginning of a stream.
type Offset string

const (
	// StartOffset represents the beginning of a stream.
	// Use this to read from the start: stream.Read(ctx, WithOffset(StartOffset))
	StartOffset Offset = "-1"
)

// String returns the offset as a string.
func (o Offset) String() string {
	return string(o)
}

// IsStart returns true if this offset represents the start of stream.
func (o Offset) IsStart() bool {
	return o == StartOffset || o == ""
}

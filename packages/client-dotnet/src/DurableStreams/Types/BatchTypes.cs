namespace DurableStreams;

/// <summary>
/// A batch of JSON items with metadata.
/// </summary>
/// <typeparam name="T">The type of items in the batch.</typeparam>
public readonly record struct JsonBatch<T>(
    IReadOnlyList<T> Items,
    StreamCheckpoint Checkpoint,
    bool UpToDate);

/// <summary>
/// A chunk of raw bytes with metadata.
/// </summary>
public readonly record struct ByteChunk(
    ReadOnlyMemory<byte> Data,
    StreamCheckpoint Checkpoint,
    bool UpToDate);

/// <summary>
/// A chunk of text with metadata.
/// </summary>
public readonly record struct TextChunk(
    string Text,
    StreamCheckpoint Checkpoint,
    bool UpToDate);

/// <summary>
/// Stream metadata from HEAD request.
/// </summary>
public readonly record struct StreamMetadata(
    bool Exists,
    string? ContentType,
    Offset? Offset,
    string? ETag,
    string? CacheControl,
    TimeSpan? Ttl,
    DateTimeOffset? ExpiresAt);

using System.Text.Json;

namespace DurableStreams;

/// <summary>
/// Options for configuring the DurableStreamClient.
/// </summary>
public class DurableStreamClientOptions
{
    /// <summary>
    /// Base URL for streams (optional, URLs can be absolute).
    /// </summary>
    public string? BaseUrl { get; set; }

    /// <summary>
    /// Default headers for all requests (static values).
    /// </summary>
    public Dictionary<string, string>? DefaultHeaders { get; set; }

    /// <summary>
    /// Dynamic headers evaluated at the start of each operation. Use for token refresh,
    /// correlation IDs, or other values that change between operations.
    /// Note: Headers are evaluated once per operation, not re-evaluated on retries.
    /// </summary>
    public Dictionary<string, Func<CancellationToken, ValueTask<string>>>? DynamicHeaders { get; set; }

    /// <summary>
    /// Timeout for individual operations.
    /// </summary>
    public TimeSpan? Timeout { get; set; }

    /// <summary>
    /// Maximum number of retries for transient errors.
    /// </summary>
    public int MaxRetries { get; set; } = 3;

    /// <summary>
    /// Initial delay for exponential backoff.
    /// </summary>
    public TimeSpan InitialRetryDelay { get; set; } = TimeSpan.FromMilliseconds(100);

    /// <summary>
    /// Maximum delay for exponential backoff.
    /// </summary>
    public TimeSpan MaxRetryDelay { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Backoff multiplier.
    /// </summary>
    public double RetryMultiplier { get; set; } = 2.0;

    /// <summary>
    /// JSON serialization options for reading and writing JSON data.
    /// If not specified, default System.Text.Json options are used.
    /// </summary>
    public JsonSerializerOptions? JsonSerializerOptions { get; set; }
}

/// <summary>
/// Options for creating a stream.
/// </summary>
public class CreateStreamOptions
{
    /// <summary>
    /// Content type for the stream.
    /// </summary>
    public string? ContentType { get; set; }

    /// <summary>
    /// Time-to-live for the stream.
    /// </summary>
    public TimeSpan? Ttl { get; set; }

    /// <summary>
    /// Absolute expiry time.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>
    /// Initial data to write to the stream.
    /// </summary>
    public byte[]? InitialData { get; set; }

    /// <summary>
    /// Additional headers for the request.
    /// </summary>
    public Dictionary<string, string>? Headers { get; set; }
}

/// <summary>
/// Options for appending to a stream.
/// </summary>
public class AppendOptions
{
    /// <summary>
    /// Sequence number for writer coordination.
    /// </summary>
    public string? Seq { get; set; }

    /// <summary>
    /// Additional headers for the request.
    /// </summary>
    public Dictionary<string, string>? Headers { get; set; }
}

/// <summary>
/// Options for reading from a stream.
/// </summary>
public class StreamOptions
{
    /// <summary>
    /// Starting offset. Use Offset.Beginning for start, Offset.Now for tail.
    /// </summary>
    public Offset? Offset { get; set; }

    /// <summary>
    /// Live mode: Off (catch-up only), LongPoll, or Sse.
    /// </summary>
    public LiveMode Live { get; set; } = LiveMode.Off;

    /// <summary>
    /// Cursor for CDN collapsing (from previous response).
    /// </summary>
    public string? Cursor { get; set; }

    /// <summary>
    /// Resume from a saved checkpoint (sets Offset and Cursor).
    /// This is a convenience property that decomposes the checkpoint.
    /// </summary>
    public StreamCheckpoint? Checkpoint
    {
        set
        {
            if (value.HasValue)
            {
                Offset = value.Value.Offset;
                Cursor = value.Value.Cursor;
            }
        }
    }

    /// <summary>
    /// Additional headers for the request.
    /// </summary>
    public Dictionary<string, string>? Headers { get; set; }
}

/// <summary>
/// Options for idempotent producer.
/// </summary>
public class IdempotentProducerOptions
{
    /// <summary>
    /// Starting epoch. Increment on producer restart.
    /// </summary>
    public int Epoch { get; set; } = 0;

    /// <summary>
    /// Auto-claim on 403 (stale epoch).
    /// </summary>
    public bool AutoClaim { get; set; } = false;

    /// <summary>
    /// Maximum bytes before sending a batch.
    /// </summary>
    public int MaxBatchBytes { get; set; } = 1024 * 1024; // 1MB

    /// <summary>
    /// Maximum time to wait for more messages before sending.
    /// </summary>
    public TimeSpan Linger { get; set; } = TimeSpan.FromMilliseconds(5);

    /// <summary>
    /// Maximum concurrent batches in flight.
    /// </summary>
    public int MaxInFlight { get; set; } = 5;

    /// <summary>
    /// Maximum number of messages that can be buffered.
    /// </summary>
    public int MaxBufferedMessages { get; set; } = 10_000;

    /// <summary>
    /// Maximum total bytes that can be buffered.
    /// </summary>
    public long MaxBufferedBytes { get; set; } = 64 * 1024 * 1024;

    /// <summary>
    /// Content type for the stream.
    /// </summary>
    public string? ContentType { get; set; }
}

/// <summary>
/// Result of an append operation.
/// </summary>
public readonly record struct AppendResult(
    Offset? NextOffset,
    bool Duplicate = false);

/// <summary>
/// Result of creating a stream.
/// </summary>
public enum CreateStreamResult
{
    /// <summary>
    /// A new stream was created (HTTP 201).
    /// </summary>
    Created,

    /// <summary>
    /// The stream already existed (HTTP 200).
    /// </summary>
    AlreadyExisted
}

/// <summary>
/// Event arguments for producer errors.
/// </summary>
public class ProducerErrorEventArgs : EventArgs
{
    /// <summary>
    /// The exception that occurred.
    /// </summary>
    public required Exception Exception { get; init; }

    /// <summary>
    /// Whether the error is retryable.
    /// </summary>
    public required bool IsRetryable { get; init; }

    /// <summary>
    /// The epoch when the error occurred.
    /// </summary>
    public required int Epoch { get; init; }

    /// <summary>
    /// The sequence range of the failed batch.
    /// </summary>
    public required (int StartSeq, int EndSeq) SequenceRange { get; init; }

    /// <summary>
    /// Number of messages in the failed batch.
    /// </summary>
    public required int MessageCount { get; init; }
}

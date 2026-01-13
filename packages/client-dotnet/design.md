# Durable Streams C#/.NET Client Design

## Executive Summary

This document outlines the design for a C#/.NET client library for Durable Streams. The design synthesizes best practices from major streaming platforms (Kafka, Redis Streams, NATS JetStream, Apache Pulsar, AWS Kinesis, Google Pub/Sub, Azure Event Hubs, RabbitMQ Streams) while maintaining consistency with existing Durable Streams clients (TypeScript, Python, Go).

## Research Summary

### Patterns Across Streaming SDKs

| Platform             | Producer Pattern          | Consumer Pattern             | Key .NET Features                                        |
| -------------------- | ------------------------- | ---------------------------- | -------------------------------------------------------- |
| **Confluent Kafka**  | `IProducer<TKey,TValue>`  | `IConsumer<TKey,TValue>`     | Interfaces for mocking, DI support, `enable.idempotence` |
| **Redis Streams**    | `StreamAdd`               | `StreamRead/StreamReadGroup` | No blocking reads in StackExchange.Redis                 |
| **NATS JetStream**   | `IJetStream.PublishAsync` | `Consume/Fetch/Next`         | New v2 API simplifies semantics                          |
| **Apache Pulsar**    | `IProducer<T>`            | `IConsumer<T>`               | Builder pattern, state monitoring                        |
| **AWS Kinesis**      | `PutRecordAsync`          | `GetRecordsAsync`            | Shard iterators, fully async                             |
| **Google Pub/Sub**   | `PublisherClient`         | `SubscriberClient`           | Singleton pattern, `IAsyncDisposable`                    |
| **Azure Event Hubs** | `EventHubProducerClient`  | `EventHubConsumerClient`     | Buffered producer option, AMQP/WebSocket                 |
| **RabbitMQ Streams** | `Producer/RawProducer`    | `Consumer/RawConsumer`       | Auto-reconnect, flow control                             |

### Key Design Principles Identified

1. **Interfaces for testability** (Kafka, Pulsar): All clients expose interfaces (`IProducer`, `IConsumer`) for mocking
2. **Builder pattern for configuration** (Pulsar, Entity Framework): Fluent APIs for complex configuration
3. **Singleton lifecycle** (Pub/Sub, Event Hubs): Expensive-to-create clients designed for reuse
4. **`IAsyncDisposable`** (Pub/Sub, Event Hubs): Proper async cleanup
5. **`IAsyncEnumerable<T>`** (modern .NET): Streaming consumption with backpressure
6. **`CancellationToken` everywhere** (all platforms): Cooperative cancellation
7. **Fire-and-forget with callbacks** (Kafka, our TypeScript): Batching producers with error callbacks

---

## API Design

### Package Structure

```
DurableStreams/
├── DurableStreams.csproj
├── IDurableStreamClient.cs      # Main client interface
├── DurableStreamClient.cs       # Client implementation
├── DurableStreamClientBuilder.cs
├── IDurableStream.cs            # Stream handle interface
├── DurableStream.cs             # Stream handle implementation
├── IIdempotentProducer.cs       # Producer interface
├── IdempotentProducer.cs        # Producer implementation
├── IdempotentProducerBuilder.cs
├── StreamResponse.cs            # Read session
├── Types/
│   ├── Offset.cs
│   ├── LiveMode.cs
│   ├── JsonBatch.cs
│   ├── ByteChunk.cs
│   └── TextChunk.cs
├── Exceptions/
│   ├── DurableStreamException.cs
│   ├── StaleEpochException.cs
│   ├── SequenceGapException.cs
│   └── StreamNotFoundException.cs
└── Options/
    ├── DurableStreamOptions.cs
    ├── StreamOptions.cs
    ├── IdempotentProducerOptions.cs
    └── BackoffOptions.cs
```

### Target Framework

- **.NET 8.0+** (required)

> **Note**: We target .NET 8+ only (no .NET Standard 2.1) because the implementation
> relies on modern APIs like `PeriodicTimer`, `Channel<T>` optimizations, and HTTP/2
> multiplexing that are not available or performant on older runtimes. For 2026-era
> .NET development, this is the pragmatic choice.

### NuGet Package Name

```
DurableStreams
```

---

## Core Interfaces

### 1. IDurableStreamClient

The main entry point, analogous to `AmazonKinesisClient` or `EventHubProducerClient`.

```csharp
/// <summary>
/// Factory for creating stream handles. Thread-safe, designed for singleton use.
/// </summary>
public interface IDurableStreamClient : IAsyncDisposable
{
    /// <summary>
    /// Create a cold handle to a stream (no network I/O).
    /// </summary>
    IDurableStream GetStream(string url);
    IDurableStream GetStream(Uri uri);

    /// <summary>
    /// Create a cold handle to a stream with custom options.
    /// </summary>
    IDurableStream GetStream(string url, StreamHandleOptions options);

    /// <summary>
    /// Create a new stream and return a handle.
    /// </summary>
    Task<IDurableStream> CreateStreamAsync(
        string url,
        CreateStreamOptions? options = null,
        CancellationToken cancellationToken = default);
    Task<IDurableStream> CreateStreamAsync(
        Uri uri,
        CreateStreamOptions? options = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Validate that a stream exists via HEAD and return a handle.
    /// </summary>
    Task<IDurableStream> ConnectAsync(
        string url,
        StreamHandleOptions? options = null,
        CancellationToken cancellationToken = default);
    Task<IDurableStream> ConnectAsync(
        Uri uri,
        StreamHandleOptions? options = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Delete a stream.
    /// </summary>
    Task DeleteStreamAsync(
        string url,
        CancellationToken cancellationToken = default);
    Task DeleteStreamAsync(
        Uri uri,
        CancellationToken cancellationToken = default);
}
```

### 2. IDurableStream

A lightweight, reusable handle to a specific stream. Matches the TypeScript `DurableStream` class.

```csharp
/// <summary>
/// A handle to a durable stream for read/write operations.
/// Lightweight and reusable - not a persistent connection.
/// </summary>
public interface IDurableStream
{
    /// <summary>
    /// The stream URL.
    /// </summary>
    string Url { get; }

    /// <summary>
    /// The content type (populated after HEAD/read).
    /// </summary>
    string? ContentType { get; }

    // === Write Operations ===

    /// <summary>
    /// Append data to the stream.
    /// Returns AppendResult with NextOffset and Duplicate flag.
    /// </summary>
    Task<AppendResult> AppendAsync(
        ReadOnlyMemory<byte> data,
        AppendOptions? options = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Append a JSON-serializable object to the stream.
    /// </summary>
    Task<AppendResult> AppendJsonAsync<T>(
        T data,
        AppendOptions? options = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Append string data to the stream.
    /// </summary>
    Task<AppendResult> AppendAsync(
        string data,
        AppendOptions? options = null,
        CancellationToken cancellationToken = default);

    // === Read Operations ===

    /// <summary>
    /// Start a streaming read session.
    /// Returns a StreamResponse for consuming data via various patterns.
    /// </summary>
    Task<StreamResponse> StreamAsync(
        StreamOptions? options = null,
        CancellationToken cancellationToken = default);

    // === Metadata Operations ===

    /// <summary>
    /// Get stream metadata via HEAD request.
    /// </summary>
    Task<StreamMetadata> HeadAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Create this stream if it doesn't exist.
    /// Returns Created if a new stream was created, or AlreadyExisted if it existed.
    /// </summary>
    Task<CreateStreamResult> CreateAsync(
        CreateStreamOptions? options = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Delete this stream.
    /// </summary>
    Task DeleteAsync(CancellationToken cancellationToken = default);

    // === Idempotent Producer Factory ===

    /// <summary>
    /// Create an idempotent producer for exactly-once writes.
    /// </summary>
    IIdempotentProducer CreateProducer(
        string producerId,
        IdempotentProducerOptions? options = null);
}
```

### 3. StreamResponse

The streaming read session, with multiple consumption patterns.

> **Consumer Semantics**: `StreamResponse` is a **single-consumer** abstraction.
> Only ONE of the `Read*Async()` or `ReadAll*Async()` methods should be called
> per response instance. Calling multiple methods on the same response will result
> in partial/interleaved data or `InvalidOperationException`. If you need multiple
> consumption modes, create separate `StreamAsync()` sessions.

```csharp
/// <summary>
/// A streaming read session with multiple consumption patterns.
/// Implements IAsyncDisposable for proper cleanup.
///
/// IMPORTANT: This is a single-consumer abstraction. Only call ONE Read* method
/// per response instance. The response owns a network connection and must be
/// disposed via 'await using'.
/// </summary>
public class StreamResponse : IAsyncDisposable
{
    // === Session Info ===

    public string Url { get; }
    public string? ContentType { get; }
    public LiveMode Live { get; }
    public Offset StartOffset { get; }

    // === Evolving State ===

    /// <summary>
    /// Current offset (advances as data is consumed).
    /// </summary>
    public Offset Offset { get; }

    /// <summary>
    /// Current checkpoint (offset + cursor for resumption).
    /// </summary>
    public StreamCheckpoint Checkpoint { get; }

    /// <summary>
    /// Whether we've reached the current end of stream.
    /// </summary>
    public bool UpToDate { get; }

    // === Accumulating Helpers (catch-up only) ===

    /// <summary>
    /// Accumulate all bytes until upToDate, then return.
    /// </summary>
    public Task<byte[]> ReadAllBytesAsync(
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Accumulate all JSON items until upToDate, then return.
    /// </summary>
    public Task<List<T>> ReadAllJsonAsync<T>(
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Accumulate all text until upToDate, then return.
    /// </summary>
    public Task<string> ReadAllTextAsync(
        CancellationToken cancellationToken = default);

    // === IAsyncEnumerable Streams ===

    /// <summary>
    /// Stream raw byte chunks as they arrive.
    /// </summary>
    public IAsyncEnumerable<ByteChunk> ReadBytesAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken = default);

    /// <summary>
    /// Stream individual JSON items as they arrive.
    /// </summary>
    public IAsyncEnumerable<T> ReadJsonAsync<T>(
        [EnumeratorCancellation] CancellationToken cancellationToken = default);

    /// <summary>
    /// Stream JSON batches with metadata as they arrive.
    /// </summary>
    public IAsyncEnumerable<JsonBatch<T>> ReadJsonBatchesAsync<T>(
        [EnumeratorCancellation] CancellationToken cancellationToken = default);

    /// <summary>
    /// Stream text chunks as they arrive.
    /// </summary>
    public IAsyncEnumerable<TextChunk> ReadTextAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken = default);

    // === Lifecycle ===

    /// <summary>
    /// Cancel the session.
    /// </summary>
    public void Cancel();
}
```

### 4. IIdempotentProducer

Fire-and-forget producer with exactly-once semantics. Matches the TypeScript implementation.

```csharp
/// <summary>
/// Fire-and-forget producer with exactly-once write semantics.
/// Thread-safe for concurrent Append calls.
/// </summary>
public interface IIdempotentProducer : IAsyncDisposable
{
    /// <summary>
    /// Current epoch.
    /// </summary>
    int Epoch { get; }

    /// <summary>
    /// Next sequence number to be assigned.
    /// </summary>
    int NextSeq { get; }

    /// <summary>
    /// Number of messages in the current pending batch.
    /// </summary>
    int PendingCount { get; }

    /// <summary>
    /// Number of batches currently in flight.
    /// </summary>
    int InFlightCount { get; }

    /// <summary>
    /// Append data (fire-and-forget). Returns immediately.
    /// Errors reported via OnError callback.
    /// </summary>
    void Append(ReadOnlyMemory<byte> data);

    /// <summary>
    /// Append JSON-serializable data (fire-and-forget).
    /// </summary>
    void Append<T>(T data);

    /// <summary>
    /// Append string data (fire-and-forget).
    /// </summary>
    void Append(string data);

    /// <summary>
    /// Flush pending batches and wait for all in-flight batches.
    /// </summary>
    Task FlushAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Increment epoch and reset sequence (for restart scenarios).
    /// </summary>
    Task RestartAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Event raised when a batch error occurs.
    /// May fire from background threads; handlers should be thread-safe.
    /// </summary>
    event EventHandler<ProducerErrorEventArgs>? OnError;

    /// <summary>
    /// Attempt to append data without blocking. Returns false if buffer is full.
    /// Use this for backpressure-aware producers.
    /// </summary>
    bool TryAppend(ReadOnlyMemory<byte> data);

    /// <summary>
    /// Attempt to append JSON data without blocking. Returns false if buffer is full.
    /// </summary>
    bool TryAppend<T>(T data);
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
    /// Whether the error is retryable (e.g., transient network error).
    /// </summary>
    public required bool IsRetryable { get; init; }

    /// <summary>
    /// The epoch when the error occurred.
    /// </summary>
    public required int Epoch { get; init; }

    /// <summary>
    /// The sequence range of the failed batch [StartSeq, EndSeq].
    /// </summary>
    public required (int StartSeq, int EndSeq) SequenceRange { get; init; }

    /// <summary>
    /// Number of messages in the failed batch.
    /// </summary>
    public required int MessageCount { get; init; }
```

---

## Configuration Options

### DurableStreamClientOptions

```csharp
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
    /// JSON serialization options for reading and writing JSON data.
    /// If not specified, default System.Text.Json options are used.
    /// </summary>
    public JsonSerializerOptions? JsonSerializerOptions { get; set; }

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
}
```

### IdempotentProducerOptions

```csharp
public class IdempotentProducerOptions
{
    /// <summary>
    /// Starting epoch. Increment on producer restart.
    /// </summary>
    public int Epoch { get; set; } = 0;

    /// <summary>
    /// Auto-claim on 403 (stale epoch).
    /// Useful for serverless/ephemeral producers.
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
    /// Maximum number of messages that can be buffered before backpressure
    /// is applied. When reached, Append() blocks and TryAppend() returns false.
    /// Default: 10000. Set to 0 for unbounded (not recommended).
    /// </summary>
    public int MaxBufferedMessages { get; set; } = 10_000;

    /// <summary>
    /// Maximum total bytes that can be buffered before backpressure is applied.
    /// Default: 64MB. Set to 0 for unbounded (not recommended).
    /// </summary>
    public long MaxBufferedBytes { get; set; } = 64 * 1024 * 1024;
}
```

### StreamOptions

```csharp
public class StreamOptions
{
    /// <summary>
    /// Starting offset. Use Offset.Beginning for start, Offset.Now for tail.
    /// </summary>
    public Offset? Offset { get; set; }

    /// <summary>
    /// Live mode: Off (catch-up only), LongPoll, or SSE.
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
    public StreamCheckpoint? Checkpoint { set; }

    /// <summary>
    /// Request-specific headers.
    /// </summary>
    public Dictionary<string, string>? Headers { get; set; }
}

public enum LiveMode
{
    /// <summary>
    /// Catch-up only, stop at first upToDate.
    /// </summary>
    Off = 0,

    /// <summary>
    /// Long-poll mode with server timeout.
    /// </summary>
    LongPoll = 1,

    /// <summary>
    /// Server-Sent Events persistent connection.
    /// </summary>
    Sse = 2
}
```

---

## .NET Ergonomic Enhancements (Future)

The following sections describe optional .NET-specific enhancements that improve developer experience but are **not required by the protocol conformance tests**. These can be implemented incrementally.

### Builder Pattern (Not Yet Implemented)

Following Pulsar and Entity Framework patterns, builders provide a fluent API for configuration:

```csharp
public class DurableStreamClientBuilder
{
    private readonly DurableStreamClientOptions _options = new();

    public DurableStreamClientBuilder WithBaseUrl(string baseUrl)
    {
        _options.BaseUrl = baseUrl;
        return this;
    }

    public DurableStreamClientBuilder WithHeader(string name, string value)
    {
        _options.DefaultHeaders ??= new Dictionary<string, HeaderValue>();
        _options.DefaultHeaders[name] = value;
        return this;
    }

    public DurableStreamClientBuilder WithHeader(
        string name,
        Func<CancellationToken, ValueTask<string>> factory)
    {
        _options.DefaultHeaders ??= new Dictionary<string, HeaderValue>();
        _options.DefaultHeaders[name] = factory;
        return this;
    }

    public DurableStreamClientBuilder WithBackoff(Action<BackoffOptions> configure)
    {
        configure(_options.Backoff);
        return this;
    }

    public DurableStreamClientBuilder WithHttpClient(Func<HttpClient> factory)
    {
        _options.HttpClientFactory = factory;
        return this;
    }

    public DurableStreamClientBuilder WithJsonOptions(JsonSerializerOptions options)
    {
        _options.JsonOptions = options;
        return this;
    }

    public IDurableStreamClient Build()
    {
        return new DurableStreamClient(_options);
    }
}

// Usage examples
var client = new DurableStreamClientBuilder()
    .WithBaseUrl("https://streams.example.com")
    .WithHeader("Authorization", async ct => await GetTokenAsync(ct))
    .WithBackoff(b => b.MaxRetries = 5)
    .Build();
```

### IdempotentProducerBuilder (Not Yet Implemented)

```csharp
public class IdempotentProducerBuilder
{
    private readonly IDurableStream _stream;
    private readonly string _producerId;
    private readonly IdempotentProducerOptions _options = new();

    public IdempotentProducerBuilder(IDurableStream stream, string producerId)
    {
        _stream = stream;
        _producerId = producerId;
    }

    public IdempotentProducerBuilder WithEpoch(int epoch)
    {
        _options.Epoch = epoch;
        return this;
    }

    public IdempotentProducerBuilder WithAutoClaim(bool autoClaim = true)
    {
        _options.AutoClaim = autoClaim;
        return this;
    }

    public IdempotentProducerBuilder WithBatching(
        int maxBatchBytes = 1024 * 1024,
        int lingerMs = 5,
        int maxInFlight = 5)
    {
        _options.MaxBatchBytes = maxBatchBytes;
        _options.LingerMs = lingerMs;
        _options.MaxInFlight = maxInFlight;
        return this;
    }

    public IIdempotentProducer Build()
    {
        return new IdempotentProducer(_stream, _producerId, _options);
    }
}

// Usage
var producer = stream.CreateProducerBuilder("order-service-1")
    .WithAutoClaim()
    .WithBatching(maxBatchBytes: 512 * 1024, lingerMs: 10)
    .Build();
```

### Dependency Injection Integration (Not Yet Implemented)

Following patterns from Confluent.Kafka.DependencyInjection and Azure SDK:

```csharp
public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Register DurableStreamClient as a singleton.
    /// </summary>
    public static IServiceCollection AddDurableStreams(
        this IServiceCollection services,
        Action<DurableStreamClientOptions>? configure = null)
    {
        services.AddSingleton<IDurableStreamClient>(sp =>
        {
            var options = new DurableStreamClientOptions();
            configure?.Invoke(options);
            return new DurableStreamClient(options);
        });

        return services;
    }

    /// <summary>
    /// Register with configuration binding.
    /// </summary>
    public static IServiceCollection AddDurableStreams(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.Configure<DurableStreamClientOptions>(
            configuration.GetSection("DurableStreams"));

        services.AddSingleton<IDurableStreamClient>(sp =>
        {
            var options = sp.GetRequiredService<IOptions<DurableStreamClientOptions>>().Value;
            return new DurableStreamClient(options);
        });

        return services;
    }
}

// Usage in Program.cs
builder.Services.AddDurableStreams(options =>
{
    options.BaseUrl = "https://streams.example.com";
    options.DefaultHeaders = new Dictionary<string, HeaderValue>
    {
        ["Authorization"] = async ct => await GetTokenAsync(ct)
    };
});

// Or from configuration
builder.Services.AddDurableStreams(builder.Configuration);
```

---

## Data Types

### Offset

```csharp
/// <summary>
/// Opaque stream offset token.
///
/// Per protocol specification (Section 6):
/// - Offsets are OPAQUE: do not parse or construct arbitrary offset values
/// - Offsets are LEXICOGRAPHICALLY SORTABLE: comparison operators are valid
///   and reflect stream position ordering
/// - Only use offsets received from the server (Stream-Next-Offset header,
///   control events) or the sentinel values (Beginning, Now)
/// </summary>
public readonly struct Offset : IEquatable<Offset>, IComparable<Offset>
{
    public static readonly Offset Beginning = new("-1");
    public static readonly Offset Now = new("now");

    private readonly string _value;

    public Offset(string value) => _value = value ?? throw new ArgumentNullException(nameof(value));

    public override string ToString() => _value;

    public static implicit operator string(Offset offset) => offset._value;
    public static explicit operator Offset(string value) => new(value);  // Explicit to prevent accidental invalid offsets

    // Lexicographic comparison
    public int CompareTo(Offset other) =>
        string.Compare(_value, other._value, StringComparison.Ordinal);

    public bool Equals(Offset other) => _value == other._value;
    public override bool Equals(object? obj) => obj is Offset o && Equals(o);
    public override int GetHashCode() => _value.GetHashCode();

    public static bool operator ==(Offset left, Offset right) => left.Equals(right);
    public static bool operator !=(Offset left, Offset right) => !left.Equals(right);
    public static bool operator <(Offset left, Offset right) => left.CompareTo(right) < 0;
    public static bool operator >(Offset left, Offset right) => left.CompareTo(right) > 0;
}
```

### StreamCheckpoint

```csharp
/// <summary>
/// A checkpoint for resuming stream consumption.
/// Combines offset (position) with cursor (CDN collapsing optimization).
/// Persist this to enable resumption after disconnection or restart.
/// </summary>
public readonly record struct StreamCheckpoint(
    Offset Offset,
    string? Cursor = null)
{
    /// <summary>
    /// Create a checkpoint from just an offset (no cursor).
    /// </summary>
    public static implicit operator StreamCheckpoint(Offset offset) => new(offset);

    /// <summary>
    /// Explicit conversion from string offset (no cursor).
    /// </summary>
    public static explicit operator StreamCheckpoint(string offset) => new(new Offset(offset));
}
```

### AppendResult

```csharp
/// <summary>
/// Result of an append operation.
/// </summary>
public readonly record struct AppendResult(
    Offset? NextOffset,
    bool Duplicate = false);
```

### Batch Types

```csharp
/// <summary>
/// A batch of JSON items with metadata.
/// </summary>
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
```

---

## Exception Hierarchy

```csharp
/// <summary>
/// Base exception for all Durable Streams errors.
/// </summary>
public class DurableStreamException : Exception
{
    public DurableStreamErrorCode Code { get; }
    public int? StatusCode { get; }
    public string? StreamUrl { get; }

    public DurableStreamException(
        string message,
        DurableStreamErrorCode code,
        int? statusCode = null,
        string? streamUrl = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
        StatusCode = statusCode;
        StreamUrl = streamUrl;
    }
}

public enum DurableStreamErrorCode
{
    Unknown,
    NotFound,
    ConflictSeq,
    ConflictExists,
    BadRequest,
    Unauthorized,
    Forbidden,
    RateLimited,
    SseNotSupported,
    AlreadyClosed
}

/// <summary>
/// Thrown when a producer's epoch is stale (zombie fencing).
/// </summary>
public class StaleEpochException : DurableStreamException
{
    public int CurrentEpoch { get; }

    public StaleEpochException(int currentEpoch)
        : base(
            $"Producer epoch is stale. Current server epoch: {currentEpoch}. " +
            "Call RestartAsync() or create a new producer with a higher epoch.",
            DurableStreamErrorCode.Forbidden,
            403)
    {
        CurrentEpoch = currentEpoch;
    }
}

/// <summary>
/// Thrown when an unrecoverable sequence gap is detected.
/// </summary>
public class SequenceGapException : DurableStreamException
{
    public int ExpectedSeq { get; }
    public int ReceivedSeq { get; }

    public SequenceGapException(int expectedSeq, int receivedSeq)
        : base(
            $"Producer sequence gap: expected {expectedSeq}, received {receivedSeq}",
            DurableStreamErrorCode.ConflictSeq,
            409)
    {
        ExpectedSeq = expectedSeq;
        ReceivedSeq = receivedSeq;
    }
}

/// <summary>
/// Thrown when a stream is not found.
/// </summary>
public class StreamNotFoundException : DurableStreamException
{
    public StreamNotFoundException(string url)
        : base($"Stream not found: {url}", DurableStreamErrorCode.NotFound, 404, url)
    {
    }
}
```

---

## Usage Examples

### Basic Read/Write

```csharp
// Create client (singleton, inject via DI in real apps)
await using var client = new DurableStreamClient(new DurableStreamClientOptions
{
    BaseUrl = "https://streams.example.com",
    DefaultHeaders = new Dictionary<string, string>
    {
        ["Authorization"] = "Bearer my-token"
    }
});

// Create a stream
var stream = client.GetStream("/my-account/chat/room-1");
await stream.CreateAsync(new CreateStreamOptions { ContentType = "application/json" });

// Append JSON data
await stream.AppendJsonAsync(new { message = "Hello, world!" });

// Read with accumulator (catch-up only)
await using var response = await stream.StreamAsync();
var messages = await response.ReadAllJsonAsync<ChatMessage>();

// Read with IAsyncEnumerable (live streaming)
await using var liveResponse = await stream.StreamAsync(
    new StreamOptions { Live = LiveMode.LongPoll });

await foreach (var message in liveResponse.ReadJsonAsync<ChatMessage>())
{
    Console.WriteLine(message.Text);
}
```

### Idempotent Producer

```csharp
// Create producer
var stream = client.GetStream("/orders/events");
await using var producer = stream.CreateProducer("order-service-1", new IdempotentProducerOptions
{
    AutoClaim = true,
    MaxBatchBytes = 1024 * 1024,
    Linger = TimeSpan.FromMilliseconds(5),
    MaxInFlight = 5
});

// Handle errors
producer.OnError += (sender, e) =>
{
    logger.LogError(e.Exception, "Producer error for batch");
};

// Fire-and-forget writes
producer.Append(new OrderCreatedEvent { OrderId = "123" });
producer.Append(new OrderCreatedEvent { OrderId = "456" });

// Ensure delivery before shutdown
await producer.FlushAsync();
```

### Live Consumption with IAsyncEnumerable

```csharp
await using var client = new DurableStreamClient(new DurableStreamClientOptions
{
    BaseUrl = "https://streams.example.com"
});

var stream = client.GetStream("/sensors/temperature");

// Use CancellationToken for graceful shutdown
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

await using var response = await stream.StreamAsync(
    new StreamOptions { Live = LiveMode.Sse });

try
{
    await foreach (var batch in response.ReadJsonBatchesAsync<TemperatureReading>(cts.Token))
    {
        foreach (var reading in batch.Items)
        {
            Console.WriteLine($"Temp: {reading.Value}C at {reading.Timestamp}");
        }

        // Save checkpoint (includes offset + cursor for optimal resumption)
        await SaveCheckpointAsync(batch.Checkpoint);
    }
}
catch (OperationCanceledException)
{
    Console.WriteLine("Shutting down gracefully...");
}
```

### ASP.NET Core Controller with Streaming Response

```csharp
[ApiController]
[Route("api/[controller]")]
public class StreamController : ControllerBase
{
    private readonly DurableStreamClient _client;

    public StreamController(DurableStreamClient client)
    {
        _client = client;
    }

    [HttpGet("{streamId}")]
    public async IAsyncEnumerable<ChatMessage> GetMessages(
        string streamId,
        [FromQuery] string? offset,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var stream = _client.GetStream($"/chats/{streamId}");

        await using var response = await stream.StreamAsync(
            new StreamOptions
            {
                Offset = offset != null ? new Offset(offset) : Offset.Beginning,
                Live = LiveMode.LongPoll
            },
            cancellationToken);

        await foreach (var message in response.ReadJsonAsync<ChatMessage>(cancellationToken))
        {
            yield return message;
        }
    }
}
```

### Dynamic Auth Token Refresh

```csharp
// Dynamic headers are evaluated per-request for token refresh
var client = new DurableStreamClient(new DurableStreamClientOptions
{
    BaseUrl = "https://streams.example.com",
    DynamicHeaders = new Dictionary<string, Func<CancellationToken, ValueTask<string>>>
    {
        ["Authorization"] = async ct =>
        {
            // Called at the start of each operation (not re-evaluated on retries)
            // Allows token refresh between operations
            var token = await tokenProvider.GetTokenAsync(ct);
            return $"Bearer {token}";
        }
    }
});
```

---

## Delivery Semantics

Understanding the delivery guarantees is critical for correct usage:

| API                            | Delivery Semantics              | When to Use                                                                    |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------ |
| `IDurableStream.AppendAsync()` | **At-most-once**                | Simple cases where duplicates are unacceptable and you handle retries yourself |
| `IIdempotentProducer.Append()` | **Exactly-once** (within epoch) | Production workloads requiring fire-and-forget with guaranteed delivery        |
| `IStreamResponse.Read*Async()` | **At-least-once**               | Always safe; offset-based resumption handles duplicates                        |

**Plain Append (`AppendAsync`)**:

- No automatic retry (to avoid duplicates)
- If the network fails mid-request, you don't know if data was written
- For critical data, use `IIdempotentProducer` instead

**Idempotent Producer**:

- Server-side deduplication via `(producerId, epoch, seq)` headers
- Safe to retry on any transient error
- Exactly-once within an epoch; at-least-once across producer restarts unless epoch is persisted

**Reads**:

- Always resumable from any checkpoint
- Protocol guarantees byte-exact resumption without skips or duplicates

---

## Implementation Details

### HTTP Transport

- Use `HttpClient` with `IHttpClientFactory` for connection pooling
- Support HTTP/2 for multiplexing
- Configurable timeouts per operation type

### Retry Policy

**Critical**: Retry behavior differs by operation to avoid data corruption.

| Operation                      | Retry Behavior                                            |
| ------------------------------ | --------------------------------------------------------- |
| **HEAD** (metadata)            | Retry on 5xx, network errors                              |
| **GET** (reads)                | Retry on 5xx, network errors (idempotent)                 |
| **PUT** (create)               | Retry on 5xx, network errors (idempotent due to protocol) |
| **DELETE**                     | Retry on 5xx, network errors (idempotent)                 |
| **POST** (plain append)        | **NO RETRY** - may cause duplicates                       |
| **POST** (idempotent producer) | Retry on 5xx, network errors (safe due to epoch/seq)      |

For `IDurableStream.AppendAsync()` (plain append without idempotent producer):

- Errors are propagated immediately to the caller
- Callers who need retry should use `IIdempotentProducer` instead
- This provides **at-most-once** semantics for plain appends

For `IIdempotentProducer`:

- Automatic retry with exponential backoff (5xx, network errors)
- Server-side deduplication via epoch/seq ensures exactly-once
- 409 (sequence gap) triggers wait-and-retry for out-of-order pipelining

### SSE Implementation

- Parse SSE events following the W3C spec
- Handle `data` events (content) and `control` events (offset/cursor)
- Implement reconnection with offset-based resumption
- Fall back to long-poll after repeated short connections (proxy buffering detection)

### Batching (IdempotentProducer)

- Use `Channel<T>` for lock-free message queuing
- Implement linger timer with `PeriodicTimer`
- Support parallel in-flight batches with sequence gap handling
- Thread-safe for concurrent `Append()` calls

### Cancellation

- All async operations accept `CancellationToken`
- Proper cleanup on cancellation (dispose HTTP responses, close connections)
- Support `[EnumeratorCancellation]` for `IAsyncEnumerable` methods

### Serialization

- Use `System.Text.Json` by default
- Support custom `JsonSerializerOptions`
- Efficient streaming deserialization with `Utf8JsonReader`
- Consider source generators for AOT scenarios

---

## Testing Strategy

### Unit Tests

- Mock `HttpMessageHandler` for HTTP behavior testing
- Test batching logic in isolation
- Test sequence gap handling
- Test SSE parsing

### Integration Tests

- Use the conformance test framework (Docker-based)
- Run against the development server
- Cover all protocol scenarios

### Mocking Support

All public types are interfaces or have virtual methods:

```csharp
// Easy to mock for testing
var mockClient = new Mock<IDurableStreamClient>();
var mockStream = new Mock<IDurableStream>();
var mockResponse = new Mock<IStreamResponse<MyMessage>>();

mockClient.Setup(c => c.GetStream(It.IsAny<string>()))
    .Returns(mockStream.Object);

mockStream.Setup(s => s.StreamAsync<MyMessage>(It.IsAny<StreamOptions>(), It.IsAny<CancellationToken>()))
    .ReturnsAsync(mockResponse.Object);
```

---

## Comparison with Existing Clients

| Feature        | TypeScript                    | Python                        | Go                          | C# (proposed)                       |
| -------------- | ----------------------------- | ----------------------------- | --------------------------- | ----------------------------------- |
| Stream Handle  | `DurableStream` class         | `DurableStream` class         | `Stream` struct             | `IDurableStream` interface          |
| Read API       | `stream()` → `StreamResponse` | `stream()` → `StreamResponse` | `Stream()` → `Response`     | `StreamAsync()` → `IStreamResponse` |
| Streaming      | `ReadableStream`, subscribers | async generators              | channels                    | `IAsyncEnumerable<T>`               |
| Batching       | `fastq`                       | `threading.Lock`              | channels                    | `Channel<T>`                        |
| Producer       | `IdempotentProducer` class    | `IdempotentProducer` class    | `IdempotentProducer` struct | `IIdempotentProducer` interface     |
| Error Handling | `onError` callback            | `on_error` callback           | error returns               | `OnError` event + exceptions        |
| Lifecycle      | N/A                           | context manager               | N/A                         | `IAsyncDisposable`                  |
| DI             | N/A                           | N/A                           | N/A                         | `IServiceCollection` extensions     |

---

## Future Considerations

1. **Source Generators**: For AOT-friendly JSON serialization
2. **Native AOT Support**: .NET 8+ Native AOT compatibility
3. **Metrics**: Integration with `System.Diagnostics.Metrics`
4. **Tracing**: OpenTelemetry `Activity` support
5. **gRPC**: Potential gRPC transport option
6. **Reactive Extensions**: `IObservable<T>` adapters

---

## Appendix: Research Sources

### Confluent Kafka .NET

- [Official Documentation](https://docs.confluent.io/kafka-clients/dotnet/current/overview.html)
- [API Design Blog](https://www.confluent.io/blog/designing-the-net-api-for-apache-kafka/)
- [GitHub](https://github.com/confluentinc/confluent-kafka-dotnet)

### Redis Streams

- [Redis .NET Tutorial](https://redis.io/learn/develop/dotnet/streams/stream-basics)
- [StackExchange.Redis Streams](https://stackexchange.github.io/StackExchange.Redis/Streams.html)

### NATS JetStream

- [NATS .NET Client](https://github.com/nats-io/nats.net)
- [JetStream Migration Guide](https://natsbyexample.com/examples/jetstream/api-migration/dotnet)

### Apache Pulsar

- [DotPulsar GitHub](https://github.com/apache/pulsar-dotpulsar)
- [Pulsar C# Docs](https://pulsar.apache.org/docs/client-libraries-dotnet/)

### AWS Kinesis

- [AWS SDK for .NET Kinesis](https://docs.aws.amazon.com/sdk-for-net/v3/developer-guide/csharp_kinesis_code_examples.html)

### Google Cloud Pub/Sub

- [.NET Client Library](https://cloud.google.com/dotnet/docs/reference/Google.Cloud.PubSub.V1/latest)

### Azure Event Hubs

- [Event Hubs Client Library](https://learn.microsoft.com/en-us/dotnet/api/overview/azure/messaging.eventhubs-readme)
- [GitHub Samples](https://github.com/Azure/azure-sdk-for-net/tree/main/sdk/eventhub/Azure.Messaging.EventHubs)

### RabbitMQ Streams

- [Stream .NET Client](https://rabbitmq.github.io/rabbitmq-stream-dotnet-client/stable/htmlsingle/index.html)
- [GitHub](https://github.com/rabbitmq/rabbitmq-stream-dotnet-client)

### .NET Best Practices

- [IAsyncEnumerable Guide](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/generate-consume-asynchronous-stream)
- [Cancellation Tokens Best Practices](https://code-maze.com/csharp-cancellation-tokens-with-iasyncenumerable/)

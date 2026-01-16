# DurableStreams for .NET

A C#/.NET client library for the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol - HTTP-based durable streams for reliable real-time data delivery to client applications.

## Installation

```bash
dotnet add package DurableStreams
```

**Requirements:** .NET 8.0 or later

## What is Durable Streams?

Durable Streams provides ordered, replayable data streams with support for catch-up reads and live tailing. Unlike WebSocket or SSE connections that lose data on disconnect, Durable Streams gives you:

- **Offset-based resumption** - Pick up exactly where you left off after any disconnection
- **Real-time tailing** - Long-poll and SSE modes for live updates
- **Exactly-once writes** - `IdempotentProducer` prevents duplicates even with retries
- **CDN-friendly** - Offset-based URLs enable aggressive caching and massive fan-out

Common use cases: AI token streaming, database sync, collaborative editing, event sourcing, workflow execution.

## Quick Start

### Reading from a Stream

```csharp
using DurableStreams;

// Create a client (singleton, reuse across your application)
await using var client = new DurableStreamClient(new DurableStreamClientOptions
{
    BaseUrl = "https://streams.example.com"
});

// Get a handle to a stream
var stream = client.GetStream("/my-account/events");

// Read all existing data (catch-up mode)
await using var response = await stream.StreamAsync(new StreamOptions
{
    Offset = Offset.Beginning,  // Start from the beginning
    Live = LiveMode.Off         // Stop when caught up
});

var messages = await response.ReadAllJsonAsync<MyEvent>();
foreach (var msg in messages)
{
    Console.WriteLine($"Event: {msg.Type}");
}
```

### Live Streaming with IAsyncEnumerable

```csharp
// Stream live updates using C#'s async enumerable
await using var response = await stream.StreamAsync(new StreamOptions
{
    Offset = Offset.Beginning,
    Live = LiveMode.LongPoll  // Wait for new data
});

await foreach (var batch in response.ReadJsonBatchesAsync<MyEvent>())
{
    foreach (var item in batch.Items)
    {
        Console.WriteLine($"Received: {item.Type}");
    }

    // Save checkpoint for resumption
    await SaveCheckpointAsync(batch.Checkpoint);

    if (batch.UpToDate)
        Console.WriteLine("Caught up to live!");
}
```

### Writing with Exactly-Once Semantics

```csharp
// Create an idempotent producer for reliable writes
await using var producer = stream.CreateProducer("my-service-1", new IdempotentProducerOptions
{
    AutoClaim = true,           // Auto-recover from epoch conflicts
    MaxBatchBytes = 1024 * 1024, // 1MB batch size
    Linger = TimeSpan.FromMilliseconds(5)  // Batch for 5ms before sending
});

// Handle errors (fire-and-forget model)
producer.OnError += (sender, e) =>
{
    Console.WriteLine($"Batch failed: {e.Exception.Message}");
};

// Fire-and-forget writes - automatically batched and pipelined
foreach (var evt in events)
{
    producer.Append(evt);  // Don't await - errors go to OnError
}

// Ensure all messages are delivered before shutdown
await producer.FlushAsync();
```

## Core Concepts

### Streams and Handles

A `DurableStream` is a lightweight handle to a stream URL. It doesn't hold a connection - you can create many handles and use them from multiple threads.

```csharp
// Get a handle (no network I/O)
var stream = client.GetStream("/my-stream");

// Or create the stream on the server
await stream.CreateAsync(new CreateStreamOptions
{
    ContentType = "application/json",
    Ttl = TimeSpan.FromHours(1)  // Auto-delete after 1 hour
});
```

### Offsets and Resumption

Offsets are opaque tokens that identify positions within a stream. Always use offsets returned by the server.

```csharp
// Special offset values
Offset.Beginning  // "-1" - Start of stream
Offset.Now        // "now" - Current tail (skip existing data)

// Resume from a saved checkpoint (simplest approach)
var response = await stream.StreamAsync(new StreamOptions
{
    Checkpoint = savedCheckpoint  // Sets Offset and Cursor automatically
});

// Save the checkpoint as you consume
await foreach (var chunk in response.ReadBytesAsync())
{
    await ProcessDataAsync(chunk.Data);
    await SaveCheckpointAsync(chunk.Checkpoint);  // Includes Offset + Cursor
}
```

### Live Modes

```csharp
LiveMode.Off       // Catch-up only - stop at first UpToDate
LiveMode.LongPoll  // HTTP polling with server timeout
LiveMode.Sse       // Server-Sent Events persistent connection
```

## API Reference

### DurableStreamClient

The main entry point. Thread-safe, designed for singleton use.

```csharp
public sealed class DurableStreamClient : IAsyncDisposable
{
    // Create a handle (no network I/O)
    DurableStream GetStream(string url);
    DurableStream GetStream(Uri uri);

    // Create a stream and return a handle
    Task<DurableStream> CreateStreamAsync(string url, CreateStreamOptions? options = null);
    Task<DurableStream> CreateStreamAsync(Uri uri, CreateStreamOptions? options = null);

    // Validate existence via HEAD and return a handle
    Task<DurableStream> ConnectAsync(string url);
    Task<DurableStream> ConnectAsync(Uri uri);

    // Delete a stream
    Task DeleteStreamAsync(string url);
    Task DeleteStreamAsync(Uri uri);
}
```

### DurableStream

A handle for read/write operations on a specific stream.

```csharp
public sealed class DurableStream
{
    string Url { get; }
    string? ContentType { get; }

    // Write operations
    Task<AppendResult> AppendAsync(ReadOnlyMemory<byte> data, AppendOptions? options = null);
    Task<AppendResult> AppendAsync(string data, AppendOptions? options = null);
    Task<AppendResult> AppendJsonAsync<T>(T data, AppendOptions? options = null);

    // Read operations
    Task<StreamResponse> StreamAsync(StreamOptions? options = null);

    // Metadata
    Task<StreamMetadata> HeadAsync();
    Task<CreateStreamResult> CreateAsync(CreateStreamOptions? options = null);
    Task DeleteAsync();

    // Create an idempotent producer
    IdempotentProducer CreateProducer(string producerId, IdempotentProducerOptions? options = null);
}
```

### StreamResponse

A streaming read session with multiple consumption patterns.

> **Important:** `StreamResponse` is a single-consumer abstraction. Only call ONE `Read*Async()` method per instance.

```csharp
public class StreamResponse : IAsyncDisposable
{
    // State
    Offset Offset { get; }              // Current position
    Offset StartOffset { get; }         // Where we started
    StreamCheckpoint Checkpoint { get; } // For resumption
    bool UpToDate { get; }              // Caught up to tail?

    // Accumulate until UpToDate (catch-up)
    Task<byte[]> ReadAllBytesAsync();
    Task<List<T>> ReadAllJsonAsync<T>();
    Task<string> ReadAllTextAsync();

    // Stream with IAsyncEnumerable
    IAsyncEnumerable<ByteChunk> ReadBytesAsync();
    IAsyncEnumerable<T> ReadJsonAsync<T>();
    IAsyncEnumerable<JsonBatch<T>> ReadJsonBatchesAsync<T>();
    IAsyncEnumerable<TextChunk> ReadTextAsync();

    void Cancel();
}
```

### IdempotentProducer

Fire-and-forget producer with exactly-once semantics.

```csharp
public class IdempotentProducer : IAsyncDisposable
{
    int Epoch { get; }        // Current epoch
    int NextSeq { get; }      // Next sequence number
    int PendingCount { get; } // Messages in current batch
    int InFlightCount { get; } // Batches being sent

    void Append(ReadOnlyMemory<byte> data);
    void Append<T>(T data);       // JSON-serializable
    void Append(string data);

    bool TryAppend(ReadOnlyMemory<byte> data); // Non-blocking
    bool TryAppend<T>(T data);

    Task FlushAsync();    // Send pending and wait
    Task RestartAsync();  // Increment epoch

    event EventHandler<ProducerErrorEventArgs>? OnError;
}
```

## Configuration

### Client Options

```csharp
var client = new DurableStreamClient(new DurableStreamClientOptions
{
    BaseUrl = "https://streams.example.com",

    // Static headers
    DefaultHeaders = new Dictionary<string, string>
    {
        ["Authorization"] = "Bearer my-token"
    },

    // Dynamic headers (evaluated at the start of each operation)
    // Note: Not re-evaluated on retries within the same operation
    DynamicHeaders = new Dictionary<string, Func<CancellationToken, ValueTask<string>>>
    {
        ["Authorization"] = async ct =>
        {
            var token = await tokenProvider.GetTokenAsync(ct);
            return $"Bearer {token}";
        }
    },

    // Custom JSON serialization options (optional)
    JsonSerializerOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    },

    // Retry configuration
    MaxRetries = 3,
    InitialRetryDelay = TimeSpan.FromMilliseconds(100),
    MaxRetryDelay = TimeSpan.FromSeconds(30)
});
```

### Producer Options

```csharp
var producer = stream.CreateProducer("my-producer", new IdempotentProducerOptions
{
    Epoch = 0,                  // Starting epoch (increment on restart)
    AutoClaim = true,           // Auto-increment epoch on 403
    MaxBatchBytes = 1024 * 1024, // 1MB
    Linger = TimeSpan.FromMilliseconds(5),  // Wait for more messages
    MaxInFlight = 5,            // Concurrent batches
    MaxBufferedMessages = 10_000,
    MaxBufferedBytes = 64 * 1024 * 1024  // 64MB
});
```

## Delivery Semantics

| API                  | Semantics     | When to Use                      |
| -------------------- | ------------- | -------------------------------- |
| `AppendAsync()`      | At-most-once  | Simple cases, you handle retries |
| `IdempotentProducer` | Exactly-once  | Production workloads             |
| `StreamAsync()`      | At-least-once | Reads are always resumable       |

## Error Handling

```csharp
try
{
    await stream.AppendAsync(data);
}
catch (StreamNotFoundException)
{
    // Stream doesn't exist (404)
}
catch (StaleEpochException ex)
{
    // Producer epoch is stale (403) - another producer claimed ownership
    Console.WriteLine($"Current server epoch: {ex.CurrentEpoch}");
}
catch (SequenceGapException ex)
{
    // Sequence gap detected (409)
    Console.WriteLine($"Expected: {ex.ExpectedSeq}, Got: {ex.ReceivedSeq}");
}
catch (DurableStreamException ex)
{
    // Other protocol errors
    Console.WriteLine($"Error {ex.Code}: {ex.Message}");
}
```

## ASP.NET Core Integration

```csharp
// Register as singleton
builder.Services.AddSingleton(new DurableStreamClient(new DurableStreamClientOptions
{
    BaseUrl = builder.Configuration["DurableStreams:BaseUrl"]
}));

// Use in a controller
[ApiController]
[Route("api/[controller]")]
public class EventsController : ControllerBase
{
    private readonly DurableStreamClient _client;

    public EventsController(DurableStreamClient client) => _client = client;

    [HttpGet("{streamId}")]
    public async IAsyncEnumerable<MyEvent> GetEvents(
        string streamId,
        [FromQuery] string? offset,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var stream = _client.GetStream($"/events/{streamId}");

        await using var response = await stream.StreamAsync(new StreamOptions
        {
            Offset = offset != null ? new Offset(offset) : Offset.Beginning,
            Live = LiveMode.LongPoll
        }, ct);

        await foreach (var item in response.ReadJsonAsync<MyEvent>(ct))
        {
            yield return item;
        }
    }
}
```

## AI Token Streaming Example

```csharp
// Server: Stream LLM tokens with exactly-once delivery
var stream = await client.CreateStreamAsync($"/generations/{generationId}",
    new CreateStreamOptions { ContentType = "text/plain" });

await using var producer = stream.CreateProducer(generationId, new IdempotentProducerOptions
{
    AutoClaim = true,
    Linger = TimeSpan.FromMilliseconds(10)  // Low latency for token streaming
});

bool fenced = false;
producer.OnError += (_, e) =>
{
    if (e.Exception is StaleEpochException)
    {
        fenced = true;  // Another worker took over
    }
};

await foreach (var token in llm.StreamAsync(prompt))
{
    if (fenced) break;
    producer.Append(token);
}

await producer.FlushAsync();

// Client: Resume from last position (refresh-safe)
await using var response = await stream.StreamAsync(new StreamOptions
{
    Offset = savedOffset,
    Live = LiveMode.LongPoll
});

await foreach (var chunk in response.ReadTextAsync())
{
    RenderToken(chunk.Text);
    await SaveOffsetAsync(chunk.Checkpoint);
}
```

## Testing

All public types are concrete classes suitable for mocking with Moq or NSubstitute.

```csharp
var mockProducer = new Mock<IdempotentProducer>();
mockProducer.Setup(p => p.Append(It.IsAny<string>()));
```

## Conformance

This client passes all 177 Durable Streams conformance tests, ensuring full protocol compatibility.

## License

Apache-2.0

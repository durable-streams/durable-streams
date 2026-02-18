# Client Libraries

Durable Streams has official client libraries in 10 languages. All implement the same [protocol](../PROTOCOL.md) and pass the client conformance test suite (221 tests), ensuring consistent behavior regardless of which language you use.

If your language isn't listed here, you can build your own client -- see [Building a Client](building-a-client.md) for a guide.

## Summary

| Language | Package | Install |
|----------|---------|---------|
| TypeScript | `@durable-streams/client` | `npm install @durable-streams/client` |
| Python | `durable-streams` | `pip install durable-streams` |
| Go | `durablestreams` | `go get github.com/durable-streams/durable-streams/packages/client-go` |
| Elixir | `durable_streams` | `{:durable_streams, "~> 0.1.0"}` in `mix.exs` |
| C# / .NET | `DurableStreams` | `dotnet add package DurableStreams` |
| Swift | `DurableStreams` | Swift Package Manager (see below) |
| PHP | `durable-streams/client` | `composer require durable-streams/client` |
| Java | `durable-streams` | Maven/Gradle (see below) |
| Rust | `durable-streams` | `cargo add durable-streams` |
| Ruby | `durable_streams` | `gem install durable_streams` |

## TypeScript

```bash
npm install @durable-streams/client
```

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({ url: "https://streams.example.com/my-stream" })
const items = await res.json()
```

- Fetch-like `stream()` API with multiple consumption patterns (promises, ReadableStreams, subscribers)
- `IdempotentProducer` with automatic batching and pipelining (up to 5 concurrent batches)
- Rich `StreamResponse` with `.json()`, `.text()`, `.body()`, `.jsonStream()`, and subscriber methods
- Dynamic headers and params via sync/async functions for token refresh
- Full Web Streams API support with Safari/iOS async-iterable compatibility

Full documentation: [README](../packages/client/README.md)

## Python

```bash
pip install durable-streams
```

```python
from durable_streams import stream

with stream("https://streams.example.com/my-stream") as res:
    for item in res.iter_json():
        print(item)
```

- Both sync (`stream()` / `DurableStream`) and async (`astream()` / `AsyncDurableStream`) APIs
- Generator-based streaming for memory-efficient consumption
- `IdempotentProducer` with fire-and-forget `append_nowait()` and automatic batching
- Context manager support for clean resource management
- Custom JSON decoders via `decode=` parameter on `iter_json()`

Full documentation: [README](../packages/client-py/README.md)

## Go

```bash
go get github.com/durable-streams/durable-streams/packages/client-go
```

```go
client := durablestreams.NewClient()
stream := client.Stream("https://streams.example.com/my-stream")

it := stream.Read(ctx)
defer it.Close()

for {
    chunk, err := it.Next()
    if errors.Is(err, durablestreams.Done) {
        break
    }
    fmt.Println(string(chunk.Data))
}
```

- Zero dependencies -- uses only the Go standard library (`net/http`)
- Iterator-based reads with `it.Next()` / `Done` sentinel pattern
- Concurrency-safe `Client` with optimized HTTP transport and connection pooling
- `IdempotentProducer` with goroutine-based batching and pipelining
- Functional options pattern (`WithLive()`, `WithOffset()`, `WithContentType()`)

Full documentation: [packages/client-go](../packages/client-go/)

## Elixir

Add to your `mix.exs`:

```elixir
{:durable_streams, "~> 0.1.0"}
```

```elixir
alias DurableStreams.Stream, as: DS

{:ok, {items, meta}} = DS.read_json(stream, offset: "-1")
IO.inspect(items)
```

- OTP-native design with `Consumer` and `Writer` GenServers for supervision tree integration
- Pipe-friendly API with bang (`!`) and `{:ok, _}` / `{:error, _}` variants
- `Writer` GenServer for fire-and-forget batched writes with exactly-once delivery
- `Consumer` GenServer with automatic reconnection, exponential backoff, and callback-based processing
- No external dependencies -- uses Erlang's built-in `:httpc` (optional Finch for SSE)

Full documentation: [README](../packages/client-elixir/README.md)

## C# / .NET

```bash
dotnet add package DurableStreams
```

```csharp
using DurableStreams;

await using var client = new DurableStreamClient(new DurableStreamClientOptions
{
    BaseUrl = "https://streams.example.com"
});
var stream = client.GetStream("/my-stream");

await using var response = await stream.StreamAsync(new StreamOptions
{
    Offset = Offset.Beginning,
    Live = LiveMode.Off
});
var items = await response.ReadAllJsonAsync<MyEvent>();
```

- `IAsyncEnumerable<T>` support for natural `await foreach` consumption
- Thread-safe `DurableStreamClient` designed for singleton/DI registration
- `IdempotentProducer` with `OnError` event handler for fire-and-forget writes
- `StreamCheckpoint` type for easy offset + cursor persistence
- ASP.NET Core integration with `IAsyncEnumerable` controller actions

Full documentation: [README](../packages/client-dotnet/README.md)

## Swift

Add via Swift Package Manager:

```swift
dependencies: [
    .package(url: "https://github.com/durable-streams/durable-streams", from: "0.1.0")
]
```

```swift
import DurableStreams

let handle = try await DurableStream.connect(
    url: URL(string: "https://streams.example.com/my-stream")!
)
for try await event in handle.messages(as: MyEvent.self) {
    print(event)
}
```

- `AsyncSequence`-based streaming with `for try await` syntax
- `Codable` offsets for easy persistence to `UserDefaults` or `Keychain`
- iOS lifecycle integration with suspend/resume and background flush support
- Batching presets (`.highThroughput`, `.lowLatency`, `.disabled`)
- Dynamic headers via `.provider { await getToken() }` closures

Full documentation: [README](../packages/client-swift/README.md)

## PHP

```bash
composer require durable-streams/client
```

```php
use function DurableStreams\stream;

$response = stream([
    'url' => 'https://streams.example.com/my-stream',
    'offset' => '-1',
]);

foreach ($response->jsonStream() as $event) {
    echo json_encode($event) . "\n";
}
```

- Generator-based streaming for memory-efficient consumption with PHP's native `yield`
- `IdempotentProducer` with synchronous `enqueue()` / `flush()` model
- PSR-18 compatible -- use any HTTP client (Guzzle, Symfony, etc.) or the built-in cURL client
- PSR-3 structured logging support
- **Note:** Long-poll only (no SSE support due to PHP's synchronous execution model)

Full documentation: [README](../packages/client-php/README.md)

## Java

### Gradle

```kotlin
implementation("com.durablestreams:durable-streams:0.1.0")
```

### Maven

```xml
<dependency>
    <groupId>com.durablestreams</groupId>
    <artifactId>durable-streams</artifactId>
    <version>0.1.0</version>
</dependency>
```

```java
var client = DurableStream.create();

try (var chunks = client.read(url)) {
    for (var chunk : chunks) {
        System.out.println(chunk.getDataAsString());
    }
}
```

- Zero dependencies -- uses only JDK 11+ APIs (`java.net.http.HttpClient`)
- Type-safe `JsonIterator<T>` with pluggable JSON parsers (Gson, Jackson, etc.)
- `AutoCloseable` iterators for natural try-with-resources usage
- `CompletableFuture` async variants for all operations
- Thread-safe `DurableStream` client and `IdempotentProducer`

Full documentation: [README](../packages/client-java/README.md)

## Rust

Add to your `Cargo.toml`:

```toml
[dependencies]
durable-streams = "0.1"
```

```rust
use durable_streams::{Client, Offset};

let client = Client::new();
let stream = client.stream("https://streams.example.com/my-stream");

let mut reader = stream.read().offset(Offset::Beginning).build();
while let Some(chunk) = reader.next_chunk().await? {
    println!("{:?}", String::from_utf8_lossy(&chunk.data));
}
```

- Builder pattern for client, reader, and producer configuration
- `Producer` with fire-and-forget `append()` / `append_json()` and `on_error` callback
- Feature flags for TLS backend (`rustls` default, optional `native-tls`) and `tracing` integration
- Tokio-based async runtime
- Uses `reqwest` under the hood with connection pooling

Full documentation: [README](../packages/client-rust/README.md)

## Ruby

```bash
gem install durable_streams
```

```ruby
require 'durable_streams'

stream = DurableStreams.stream("/my-stream")
stream.each { |msg| puts msg }
```

- Idiomatic Ruby with `Enumerable` integration, `each` / `each_batch`, and `<<` shovel operator
- `Producer.open` block form for automatic flush/close on exit
- Lazy enumerator support (`stream.read(live: :sse).each.lazy.take(10).to_a`)
- Global configuration with `DurableStreams.configure` and isolated contexts for multi-tenant use
- Built-in testing utilities with mock transport for RSpec/Minitest

Full documentation: [README](../packages/client-rb/README.md)

## Common features across all clients

All client libraries share the same core capabilities:

- **Exactly-once writes** -- `IdempotentProducer` uses `(producerId, epoch, seq)` tuples for server-side deduplication, safe to retry on any network error
- **Offset-based resumption** -- save the offset returned by the server and pass it back on reconnect to resume from exactly where you left off
- **Long-poll and SSE live modes** -- choose between HTTP long-polling and Server-Sent Events for real-time tailing (note: PHP supports long-poll only)
- **JSON mode with array flattening** -- JSON streams automatically handle array batching on writes and flattening on reads
- **Automatic retry on transient errors** -- configurable exponential backoff for network failures and server errors

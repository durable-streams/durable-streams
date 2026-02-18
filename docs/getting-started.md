# Getting Started

There are two ways to get started with Durable Streams: using curl to interact with the server directly, or using the TypeScript client library to build applications.

## Path A: curl + server binary

The fastest way to see Durable Streams in action. No code, just HTTP.

### 1. Download and run the server

Download the latest server binary for your platform from the [GitHub releases page](https://github.com/durable-streams/durable-streams/releases/latest). Builds are available for:

- macOS (Intel and ARM)
- Linux (AMD64 and ARM64)
- Windows (AMD64)

Extract the archive and start the server in development mode:

```bash
./durable-streams-server dev
```

The server starts on `http://localhost:4437`.

### 2. Create a stream

```bash
curl -X PUT http://localhost:4437/v1/stream/my-first-stream \
  -H 'Content-Type: text/plain'
```

### 3. Append data

```bash
curl -X POST http://localhost:4437/v1/stream/my-first-stream \
  -H 'Content-Type: text/plain' \
  -d 'Hello, Durable Streams!'
```

### 4. Read the stream

```bash
curl http://localhost:4437/v1/stream/my-first-stream
```

The response body contains your data. The `Stream-Next-Offset` header tells you where to resume reading from.

### 5. Watch it live

In one terminal, start tailing the stream with SSE:

```bash
curl -N http://localhost:4437/v1/stream/my-first-stream?offset=-1&live=sse
```

In another terminal, append more data:

```bash
curl -X POST http://localhost:4437/v1/stream/my-first-stream \
  -H 'Content-Type: text/plain' \
  -d 'This appears in real time!'
```

The first terminal shows the new data as it arrives.

For more on the raw HTTP protocol, see [Concepts](concepts.md). For the full command-line interface, see [CLI Reference](cli.md).

---

## Path B: TypeScript client

For building applications with the full client library.

### 1. Install the server

Use either the binary from Path A, or install the Node.js development server:

```bash
npm install @durable-streams/server
```

Start the dev server:

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({ port: 4437 })
await server.start()
```

### 2. Install the client

```bash
npm install @durable-streams/client
```

### 3. Read a stream with `stream()`

The `stream()` function provides a fetch-like, read-only API for consuming streams:

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({
  url: "http://localhost:4437/v1/stream/my-first-stream",
  live: false,
})

const text = await res.text()
console.log(text)
```

### 4. Create a stream and write data

Use `DurableStream.create()` to create a stream, then `append()` to write:

```typescript
import { DurableStream } from "@durable-streams/client"

const handle = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/my-stream",
  contentType: "text/plain",
})

await handle.append("Hello from the TypeScript client!")
await handle.append("Another message.")
```

### 5. Exactly-once writes with `IdempotentProducer`

For reliable, high-throughput writes with exactly-once semantics, use `IdempotentProducer`. It automatically batches and pipelines writes, and the server deduplicates using a `(producerId, epoch, seq)` tuple:

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"

const handle = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/events",
  contentType: "application/json",
})

const producer = new IdempotentProducer(handle, "my-producer", {
  autoClaim: true,
  onError: (err) => console.error("Batch failed:", err),
})

producer.append({ event: "user.created", userId: "123" })
producer.append({ event: "user.updated", userId: "123" })

await producer.flush()
await producer.close()
```

### 6. Live tailing

Subscribe to a stream for real-time updates. The client handles reconnection and catch-up automatically:

```typescript
import { stream } from "@durable-streams/client"

const res = await stream<{ event: string }>({
  url: "http://localhost:4437/v1/stream/events",
  live: true,
})

res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log("Received:", item)
  }
})
```

### 7. Resuming from a saved offset

Every response includes an offset you can persist and use to resume later, picking up exactly where you left off:

```typescript
import { stream } from "@durable-streams/client"

// First read -- save the offset
const res = await stream({
  url: "http://localhost:4437/v1/stream/my-stream",
  live: false,
})
const text = await res.text()
const savedOffset = res.offset

// Later -- resume from saved offset
const resumed = await stream({
  url: "http://localhost:4437/v1/stream/my-stream",
  offset: savedOffset,
  live: false,
})
const newData = await resumed.text()
console.log("New data since last read:", newData)
```

### 8. JSON mode

Create a stream with `contentType: "application/json"` to get automatic message framing. Each `append()` stores one message, and reads return individual JSON items:

```typescript
import { DurableStream, stream } from "@durable-streams/client"

interface ChatMessage {
  user: string
  text: string
  timestamp: number
}

// Create a JSON stream
const handle = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/chat",
  contentType: "application/json",
})

// Append JSON objects
await handle.append({ user: "alice", text: "Hello!", timestamp: Date.now() })
await handle.append({ user: "bob", text: "Hi there!", timestamp: Date.now() })

// Read and iterate typed messages
const res = await stream<ChatMessage>({
  url: "http://localhost:4437/v1/stream/chat",
  live: false,
})

for await (const message of res.jsonStream()) {
  console.log(`${message.user}: ${message.text}`)
}
```

---

## Next steps

- [Introduction](introduction.md) -- what Durable Streams is and why it exists
- [Concepts](concepts.md) -- offsets, live modes, idempotent producers, and JSON mode
- [CLI Reference](cli.md) -- the command-line tool for managing streams

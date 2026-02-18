# Durable Streams

**The open protocol for real-time sync to client applications.**

Durable Streams is a persistent, URL-addressable stream primitive and HTTP protocol for reliable, resumable, real-time data streaming into client applications. It provides a simple, production-proven protocol for creating and consuming ordered, replayable data streams with support for catch-up reads and live tailing.

## The Missing Primitive

The internet has strong primitives for server-to-server messaging -- Kafka, RabbitMQ, NATS, Kinesis. They give you ordering, delivery semantics, and fault tolerance between backend services. But they're designed for backend infrastructure, not client applications.

Client streaming is a different problem. Connections are fragile: tabs get suspended, networks flap, devices switch, pages refresh. WebSockets are hard to scale, proxy, authenticate, and observe. SSE is HTTP-native but not cacheable by CDNs, not replayable, and has no standard server-side retention or catch-up protocol. With either, you lose data on disconnect or build a bespoke resume protocol on top.

AI products make this painfully visible. Token streaming is the UI for chat and copilots, and agentic apps often stream progress events, tool outputs, and partial results over long-running sessions. When the stream fails, the product fails -- even if the model did the right thing.

While durable streams exist throughout backend infrastructure (database WALs, Kafka topics, event stores), they aren't available as a first-class primitive for client applications. There's no simple, HTTP-based durable stream that sits alongside databases and object storage as a standard cloud primitive.

Durable Streams addresses this gap. It complements backend messaging systems rather than replacing them:

```
Kafka/RabbitMQ  -->  Application Server  -->  Durable Streams  -->  Clients
(server-to-server)   (auth, shaping,          (server-to-client)
                      transformation)
```

## What Are Durable Streams

Streams are a first-class primitive that get their own URL. Each stream is an addressable, append-only log that clients can read from any position.

Every position in a stream has an opaque, lexicographically sortable offset. Clients persist the last offset they've processed. On reconnect, they resume by asking for "everything after offset X". The server doesn't need per-client session state -- progress is tracked client-side.

Because reads are addressed by offset-based URLs, historical reads can be cached by CDNs. This makes it feasible to serve large numbers of clients from a single source stream.

```typescript
import { DurableStream } from "@durable-streams/client"

// Create and write to a stream
const stream = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})
await stream.append({ event: "user.created", userId: "123" })

// Read from a saved offset -- resume exactly where you left off
const res = await stream.stream({ offset: savedOffset, live: "auto" })
res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    process(item)
  }
  saveCheckpoint(batch.offset) // persist for next resume
})
```

## How It Works

**Create and append.** Create a stream with `PUT`, append data with `POST`. Each append returns the next offset in a `Stream-Next-Offset` response header.

```bash
# Create a stream
curl -X PUT https://your-server.com/v1/stream/my-stream \
  -H "Content-Type: application/json"

# Append data
curl -X POST https://your-server.com/v1/stream/my-stream \
  -H "Content-Type: application/json" \
  -d '{"event":"user.created","userId":"123"}'
# Response header: Stream-Next-Offset: abc123xyz
```

**Read and resume.** Read from an offset using `GET` for catch-up, or tail the stream using long-polling or SSE. If a connection drops, reconnect using the last saved offset.

```bash
# Read from the beginning
curl "https://your-server.com/v1/stream/my-stream?offset=-1"

# Resume from a saved offset
curl "https://your-server.com/v1/stream/my-stream?offset=abc123xyz"

# Live tail with long-polling
curl "https://your-server.com/v1/stream/my-stream?offset=abc123xyz&live=long-poll"
```

**Message boundaries.** Choose between raw byte concatenation (with your own framing) or JSON mode where the server returns batches as arrays with preserved message boundaries.

**Infrastructure-friendly.** The protocol runs over plain HTTP, including long-polling and SSE, so it fits behind CDNs and standard API gateways. Offset-based URLs make historical reads cacheable, and request collapsing means thousands of viewers at the same offset become one upstream request.

## Composable Ecosystem

Durable Streams is a foundation layer. Higher-level protocols and integrations build on top:

- **Durable Streams** -- durable, resumable delivery over HTTP
- **State Protocol** -- structured state sync (insert/update/delete) over durable streams
- **AI transports** -- durable adapters for Vercel AI SDK, TanStack AI
- **Application protocols** -- presence, CRDTs (Yjs), collaborative editing

## Performance

- **240K writes/second** for small messages, with 15-25 MB/sec sustained throughput
- Tested to **1M concurrent connections** per stream
- End-to-end sync in **under 15ms**

## Next Steps

- [Getting Started](getting-started.md) -- set up and start using Durable Streams
- [Protocol Specification](../PROTOCOL.md) -- the full protocol spec
- [Use Cases](use-cases.md) -- common patterns and applications

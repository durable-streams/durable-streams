# Getting Started

This guide walks you through starting a server, creating your first stream with curl, and then using the TypeScript client library. By the end you'll have a working stream you can write to, read from, and tail in real time.

## Start a Server

You need a running server to work with. Pick whichever option suits you:

**Option A: Caddy binary (no Node.js required)**

Download the latest binary for your platform from the [GitHub releases page](https://github.com/durable-streams/durable-streams/releases/latest) (macOS, Linux, Windows) and run:

```bash
./durable-streams-server dev
```

**Option B: Node.js server**

```bash
npm install @durable-streams/server
```

Create a file `server.mjs`:

```javascript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({ port: 4437 })
await server.start()
```

```bash
node server.mjs
```

Either way, the server starts on `http://localhost:4437`.

## Your First Stream

With the server running, you can create, write to, and read from a stream using curl.

**Create a stream:**

```bash
curl -X PUT http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain'
```

**Write some data:**

```bash
curl -X POST http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain' \
  -d 'Hello, Durable Streams!'
```

**Read it back:**

```bash
curl http://localhost:4437/v1/stream/hello
```

The response body contains your data. The `Stream-Next-Offset` response header tells you where to resume reading from.

**Watch it live.** In one terminal, start tailing the stream with SSE:

```bash
curl -N "http://localhost:4437/v1/stream/hello?offset=-1&live=sse"
```

In another terminal, write more data:

```bash
curl -X POST http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain' \
  -d 'This appears in real time!'
```

The new data appears instantly in the first terminal. That's durable streaming -- ordered, resumable, and live.

## Using the TypeScript Client

Install the client library:

```bash
npm install @durable-streams/client
```

### Writing

Create a JSON stream and append some messages:

```typescript
import { DurableStream } from "@durable-streams/client"

const handle = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/chat",
  contentType: "application/json",
})

await handle.append({ user: "alice", text: "Hello!" })
await handle.append({ user: "bob", text: "Hi there!" })
```

### Reading

Read back the messages with the `stream()` function:

```typescript
import { stream } from "@durable-streams/client"

interface ChatMessage {
  user: string
  text: string
}

const res = await stream<ChatMessage>({
  url: "http://localhost:4437/v1/stream/chat",
})

for await (const message of res.jsonStream()) {
  console.log(`${message.user}: ${message.text}`)
}
```

### Live tailing

Subscribe to a stream for real-time updates. The client handles reconnection and catch-up automatically:

```typescript
const res = await stream<ChatMessage>({
  url: "http://localhost:4437/v1/stream/chat",
  live: true,
})

res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log(`${item.user}: ${item.text}`)
  }
})
```

## Next Steps

- [Core Concepts](concepts.md) -- offsets, resumption, live modes, idempotent producers, and JSON mode
- [CLI Reference](cli.md) -- command-line tool for working with streams
- [Client Libraries](clients.md) -- official clients in 10 languages
- [TypeScript Client README](../packages/client/README.md) -- full TypeScript client API reference

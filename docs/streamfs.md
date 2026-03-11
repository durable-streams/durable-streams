# StreamFS

Use Durable Streams as the basis for a resumable filesystem when you want chunked reads and writes for binary or plain-text content.

There is not a dedicated `streamFS` package in this branch, but the core protocol already supports the underlying pattern.

## Create a byte stream

```bash
curl -X PUT http://localhost:4437/v1/stream/files/demo.bin \
  -H 'Content-Type: application/octet-stream'
```

## Append chunks

```bash
curl -X POST http://localhost:4437/v1/stream/files/demo.bin \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @chunk-1.bin
```

Append more chunks with additional `POST` requests. Each append advances the stream offset.

## Resume reads

```bash
curl "http://localhost:4437/v1/stream/files/demo.bin?offset=-1"
```

Save the returned `Stream-Next-Offset` header, then continue from there later:

```bash
curl "http://localhost:4437/v1/stream/files/demo.bin?offset=<saved-offset>"
```

## TypeScript example

```typescript
import { DurableStream, stream } from "@durable-streams/client"

const fileStream = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/files/demo.bin",
  contentType: "application/octet-stream",
})

await fileStream.append(new Uint8Array([1, 2, 3, 4]))

const res = await stream({
  url: "http://localhost:4437/v1/stream/files/demo.bin",
  offset: "-1",
})

const bytes = await res.body()
console.log(bytes)
```

## When to use it

- Use byte streams for binary blobs, chunked exports, and custom framing formats.
- Use [JSON Streams](json-streams.md) instead when you want structured message boundaries handled for you.

---
title: Quickstart
description: >-
  Get started with Durable Streams by following the Quickstart guide.
outline: [2, 3]
---

# Quickstart

Durable Streams are the data primitive for the agent loop.

Persistent, addressable, real‑time streams for building resilient agent sessions and collaborative multi-user, multi-agent systems.

## Get started

Get a Durable Streams server running in seconds. Create a stream, append data, read it back, and tail it live using curl.

### 1. Start the server

Download the latest `durable-streams-server` binary from the [GitHub releases page](https://github.com/durable-streams/durable-streams/releases/latest), then run:

```bash
./durable-streams-server dev
```

This starts an in-memory server on `http://localhost:4437` with the stream endpoint at `/v1/stream/*`.

### 2. Create a stream

```bash
curl -X PUT http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain'
```

### 3. Append some data

```bash
curl -X POST http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain' \
  -d 'Hello, Durable Streams!'
```

### 4. Read it back

```bash
curl "http://localhost:4437/v1/stream/hello?offset=-1"
```

The response body contains your stream contents. Save the `Stream-Next-Offset` response header if you want to resume from the same position later.

### 5. Tail it live

In one terminal:

```bash
curl -N "http://localhost:4437/v1/stream/hello?offset=-1&live=sse"
```

In another terminal:

```bash
curl -X POST http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain' \
  -d 'This appears in real time!'
```

The first terminal will receive the new data immediately.

## Next steps

Raw durable streams are awesome but it's what you do with them that counts. Dive into the [core concepts](/concepts) and see all of the ways you can use Durable Streams to build resilient, collaborative multi-agent systems.

Including, working with structured data and integrating into AI SDKs:

- [JSON mode](/json-mode) -- stream structured data using JSON messages
- [StreamDB](/stream-db) -- type-safe, reactive database in a stream
- [TanStack AI](/tanstack-ai) -- durable session support for TanStack AI apps
- [Vercel AI SDK](/vercel-ai-sdk) -- durable Transport adapter for AI SDK apps

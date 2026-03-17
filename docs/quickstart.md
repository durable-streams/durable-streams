---
title: Quickstart
description: >-
  Get started with Durable Streams by following the Quickstart guide.
---

# Quickstart

Get started with Durable Streams by following the Quickstart guide.

Get a Durable Streams server running in seconds. Create a stream, append data, read it back, and tail it live using curl.

## 1. Start the server

Download the latest `durable-streams-server` binary from the [GitHub releases page](https://github.com/durable-streams/durable-streams/releases/latest), then run:

```bash
./durable-streams-server dev
```

This starts an in-memory server on `http://localhost:4437` with the stream endpoint at `/v1/stream/*`.

## 2. Create a stream

```bash
curl -X PUT http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain'
```

## 3. Append some data

```bash
curl -X POST http://localhost:4437/v1/stream/hello \
  -H 'Content-Type: text/plain' \
  -d 'Hello, Durable Streams!'
```

## 4. Read it back

```bash
curl "http://localhost:4437/v1/stream/hello?offset=-1"
```

The response body contains your stream contents. Save the `Stream-Next-Offset` response header if you want to resume from the same position later.

## 5. Tail it live

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

- [Core concepts](concepts.md) for offsets, live modes, and resumption
- [CLI](cli.md) for terminal workflows
- [TypeScript client](typescript-client.md) for the TypeScript client

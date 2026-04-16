---
title: Fork
description: >-
  Create a new stream that branches from a source stream at a specific offset,
  inheriting its data without copying.
outline: [2, 3]
---

# Fork

Create a new stream that branches from a source stream at a specific offset, inheriting its data without copying.

A fork is created with a `PUT` to a new URL that carries the `Stream-Forked-From` header. Once created, the fork behaves as an independent stream.

## What fork does

A `PUT` that carries `Stream-Forked-From: <source-path>` creates a new stream that references the source's data up to `Stream-Fork-Offset`. Offsets below `Stream-Fork-Offset` resolve against the source without copying; offsets at or above resolve against the fork's own appends. `Stream-Fork-Offset` is optional and defaults to the source's current tail. The fork is independent of its source: it has its own URL, TTL, closure state, and deletion, and can outlive the source.

```
source:  [0] [1] [2] [3] [4] [5] [6] [7]
                      │
                      │ fork at offset 4
                      ▼
fork:    [0] [1] [2] [3] [4'] [5'] [6']
         └── inherited ──┘└── fork's own ──┘
```

## Using HTTP

Create a fork. `Stream-Fork-Offset` is optional and defaults to the source's current tail; `Content-Type` is optional and inherited from the source.

```bash
curl -X PUT http://localhost:4437/v1/stream/my-fork \
  -H 'Stream-Forked-From: /v1/stream/my-source' \
  -H 'Stream-Fork-Offset: 1024'
```

Read the fork. Reads transparently span the fork boundary — the client never needs to know the stream is a fork.

```bash
curl "http://localhost:4437/v1/stream/my-fork?offset=-1"
```

Append to the fork. Appends go only to the fork; the source is untouched.

```bash
curl -X POST http://localhost:4437/v1/stream/my-fork \
  -H 'Content-Type: application/octet-stream' \
  -d 'a new event only visible on the fork'
```

## Using a client library

::: code-group

```typescript [TypeScript]
import { DurableStream } from "@durable-streams/client"

// Create the fork — pass the fork headers via the existing headers option
await DurableStream.create({
  url: "http://localhost:4437/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    "Stream-Fork-Offset": "1024", // optional; defaults to source tail
  },
})

// Use a fresh handle for ongoing reads/writes
const fork = await DurableStream.connect({
  url: "http://localhost:4437/v1/stream/my-fork",
})

await fork.append("a new event only visible on the fork")
```

```python [Python]
from durable_streams import DurableStream

# Create the fork — pass the fork headers
DurableStream.create(
    "http://localhost:4437/v1/stream/my-fork",
    headers={
        "Stream-Forked-From": "/v1/stream/my-source",
        "Stream-Fork-Offset": "1024",  # optional; defaults to source tail
    },
)

# Use a fresh handle for ongoing reads/writes
fork = DurableStream.connect("http://localhost:4437/v1/stream/my-fork")
fork.append(b"a new event only visible on the fork")
```

:::

`headers` apply to every request on a given handle — use a fresh handle after create to avoid resending fork headers on reads and appends.

## TTL and expiry

A fork has its own TTL and expiry. If the fork request provides `Stream-TTL` or `Stream-Expires-At`, the fork uses those values — it can outlive the source or die earlier.

If the fork request omits expiry, the fork inherits from the source. A source with a TTL passes its TTL value on and the fork runs its own sliding window. A source with an `Expires-At` passes its hard deadline on, so the fork cannot be accidentally retained past the source's expiry. A source with no expiry yields a fork with no expiry.

## Deletion and lifecycle

- **Deleting a fork** — decrements the source's reference count and removes the fork.
- **Deleting a source with active forks** — soft-deletes it. The source URL returns `410 Gone` for all client operations and the path is blocked from re-creation (`409 Conflict`). Fork reads keep working transparently.
- **Cascading GC** — when the last fork of a soft-deleted source is deleted, the source is cleaned up. The cascade continues up the fork chain. Cleanup may be asynchronous.

## When to use it

Fork when you need a logically independent stream that shares a prefix with an existing one — without copying the prefix.

- **Branching an event log at a stable point** — run a new projection, a parallel consumer, or a deterministic replay against a fixed history.
- **Speculative or exploratory writes** — try alternative appends on a fork: AI conversation branching, scenario replay, A/B experiments.
- **Writer handoff** — one producer transitions to another at a known offset under a new URL.

## More

- [PROTOCOL.md section 4.2](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md#42-stream-forking) — normative specification, including the full fork error table
- [Core concepts](/concepts.md)

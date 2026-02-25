---
name: durable-state
description: >
  Structured state synchronization over Durable Streams using the State Protocol.
  createStreamDB() for TanStack DB-backed reactive collections, createStateSchema()
  for typed collection definitions with Zod/Valibot validation, optimistic actions
  with onMutate/mutationFn and awaitTxId confirmation. Covers ChangeEvent/ControlEvent
  format, insert/update/delete/upsert helpers, useLiveQuery reactive queries,
  preload lifecycle, and SSR clientOnly$ wrapping.
type: core
library: "@durable-streams"
library_version: "pre-1.0"
sources:
  - "durable-streams:packages/state/src/stream-db.ts"
  - "durable-streams:packages/state/src/schema.ts"
  - "durable-streams:packages/state/src/materialized-state.ts"
  - "durable-streams:packages/state/src/types.ts"
---

# Durable State — Structured State Synchronization

Build real-time, reactive state from Durable Streams. Instead of manually parsing events and tracking keys with raw `append()`/`stream()`, use `@durable-streams/state` for typed collections, reactive queries via TanStack DB, and optimistic updates with server confirmation.

If you are building presence tracking, chat rooms, synced key/value stores, or any feature that materializes structured state from a stream — use this package.

## Setup

### Define schema and create StreamDB

```typescript
import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { z } from "zod"

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["online", "offline"]),
})

const messageSchema = z.object({
  id: z.string(),
  userId: z.string(),
  text: z.string(),
  createdAt: z.string(),
})

const schema = createStateSchema({
  users: {
    schema: userSchema,
    type: "user",
    primaryKey: "id",
  },
  messages: {
    schema: messageSchema,
    type: "message",
    primaryKey: "id",
  },
})

// Create at module scope — NOT inside a component
const db = createStreamDB({
  streamOptions: {
    url: "https://localhost:4437/v1/stream/chat-room",
    contentType: "application/json",
  },
  state: schema,
})
```

### Preload in route loader (TanStack Router example)

```typescript
export const Route = createFileRoute("/chat")({
  loader: async () => {
    await db.preload()
  },
  component: ChatRoom,
})
```

## Core Patterns

### Write events with typed helpers

```typescript
import { DurableStream } from "@durable-streams/client"

const ds = await DurableStream.connect({
  url: "https://localhost:4437/v1/stream/chat-room",
})

// schema helpers produce properly typed ChangeEvents
const event = schema.users.insert({
  value: { id: "u1", name: "Kyle", status: "online" },
})
await ds.append(JSON.stringify(event))

// Update with old_value for audit trail
const updateEvent = schema.users.update({
  value: { id: "u1", name: "Kyle", status: "offline" },
  oldValue: { id: "u1", name: "Kyle", status: "online" },
})
await ds.append(JSON.stringify(updateEvent))

// Delete
const deleteEvent = schema.messages.delete({ key: "m1" })
await ds.append(JSON.stringify(deleteEvent))
```

Key derivation: if `key` is omitted, it's derived from `value[primaryKey]`.

### Reactive queries with useLiveQuery

```typescript
import { useLiveQuery } from "@tanstack/react-db"
import { eq, count } from "@tanstack/db"

function OnlineUsers() {
  const onlineUsers = useLiveQuery((q) =>
    q
      .from({ users: db.collections.users })
      .where(({ users }) => eq(users.status, "online"))
  )

  return (
    <ul>
      {onlineUsers.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}
```

TanStack DB uses differential dataflow — only affected rows recompute on changes.

### Joins and aggregation

```typescript
const messagesWithAuthors = useLiveQuery((q) =>
  q
    .from({ messages: db.collections.messages })
    .join({ users: db.collections.users }, ({ messages, users }) =>
      eq(messages.userId, users.id)
    )
    .select(({ messages, users }) => ({
      id: messages.id,
      text: messages.text,
      author: users.name,
    }))
    .orderBy(({ messages }) => messages.createdAt, "desc")
    .limit(50)
)
```

### Optimistic actions with server confirmation

```typescript
const db = createStreamDB({
  streamOptions: {
    url: "https://localhost:4437/v1/stream/chat-room",
    contentType: "application/json",
  },
  state: schema,
  actions: ({ db, stream }) => ({
    sendMessage: {
      onMutate: (msg: { id: string; userId: string; text: string }) => {
        db.collections.messages.insert({
          ...msg,
          createdAt: new Date().toISOString(),
        })
      },
      mutationFn: async (msg) => {
        const txid = crypto.randomUUID()
        await stream.append(
          JSON.stringify(
            schema.messages.insert({
              value: { ...msg, createdAt: new Date().toISOString() },
              headers: { txid },
            })
          )
        )
        await db.utils.awaitTxId(txid, 10000)
      },
    },
  }),
})

// Usage — optimistic update appears immediately, server confirms async
await db.actions.sendMessage({
  id: crypto.randomUUID(),
  userId: "u1",
  text: "Hello!",
})
```

### TanStack DB query operators

Available via `@tanstack/db` or re-exported from `@durable-streams/state`:

```typescript
import {
  eq,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  and,
  or,
  not,
  isNull,
} from "@tanstack/db"
import { count, sum, avg, min, max } from "@tanstack/db"
```

Aggregation with groupBy:

```typescript
const stats = useLiveQuery((q) => {
  const counts = q
    .from({ messages: db.collections.messages })
    .groupBy(({ messages }) => messages.userId)
    .select(({ messages }) => ({
      userId: messages.userId,
      total: count(messages.id),
    }))
  return q.from({ stats: counts }).orderBy(({ stats }) => stats.total, "desc")
})
```

## Common Mistakes

### CRITICAL Not knowing @durable-streams/state exists

Wrong:

```typescript
import { stream } from "@durable-streams/client"

const response = await stream({ url: streamUrl, live: "sse" })
const state = new Map()
response.subscribeJson((batch) => {
  for (const event of batch.items) {
    if (event.op === "insert") state.set(event.id, event)
    if (event.op === "delete") state.delete(event.id)
  }
})
```

Correct:

```typescript
import { createStreamDB, createStateSchema } from "@durable-streams/state"

const db = createStreamDB({
  streamOptions: { url: streamUrl, contentType: "application/json" },
  state: schema,
})
await db.preload()
// Collections are now reactive — use useLiveQuery for queries
```

Agents building presence, chat, or synced state should use `@durable-streams/state` instead of ad-hoc state on raw streams. StreamDB provides typed collections, reactive queries, and optimistic updates.

Source: Maintainer interview

### CRITICAL Using StreamDB during SSR

Wrong:

```typescript
export default function ChatPage() {
  const messages = useLiveQuery((q) =>
    q.from({ messages: db.collections.messages })
  )
  return <MessageList messages={messages} />
}
```

Correct:

```typescript
import { clientOnly$ } from "@tanstack/start"

const ChatRoom = clientOnly$(() => import("./ChatRoom"))

export default function ChatPage() {
  return <ChatRoom />
}
```

`createStreamDB` fetches data at initialization, which fails during server-side rendering. For TanStack Start/Router apps, wrap with `clientOnly$`.

Source: TanStack Start integration patterns

### CRITICAL Creating StreamDB inside components

Wrong:

```typescript
function ChatRoom() {
  const db = createStreamDB({ ... }) // New instance per render!
  // ...
}
```

Correct:

```typescript
// db.ts — module scope
export const db = createStreamDB({ ... })

// ChatRoom.tsx
import { db } from "./db"
function ChatRoom() {
  const messages = useLiveQuery((q) =>
    q.from({ messages: db.collections.messages })
  )
}
```

StreamDB is a stateful singleton managing a live stream connection. Creating inside a component creates a new instance per render, losing state and wasting connections.

Source: React rendering lifecycle

### HIGH Querying before preload() completes

Wrong:

```typescript
const db = createStreamDB({ ... })

function ChatRoom() {
  useEffect(() => { db.preload() }, [])
  const messages = useLiveQuery(/* ... */) // Collections empty!
}
```

Correct:

```typescript
// Preload in route loader, not useEffect
export const Route = createFileRoute("/chat")({
  loader: async () => {
    await db.preload()
  },
  component: ChatRoom,
})
```

`createStreamDB()` is synchronous and does not connect. Collections are empty until `preload()` resolves. Preload in route loader to ensure data before render.

Source: packages/state/src/stream-db.ts — preload()

### HIGH Using primitive values in collections

Wrong:

```typescript
const schema = createStateSchema({
  counters: {
    schema: z.number(),
    type: "counter",
    primaryKey: "id",
  },
})
```

Correct:

```typescript
const schema = createStateSchema({
  counters: {
    schema: z.object({ id: z.string(), value: z.number() }),
    type: "counter",
    primaryKey: "id",
  },
})
```

StreamDB collections require object values for primary key extraction. Primitive values throw "StreamDB collections require object values".

Source: packages/state/src/stream-db.ts — EventDispatcher validation

### HIGH Filtering in JavaScript instead of query builder

Wrong:

```typescript
const allMessages = useLiveQuery((q) =>
  q.from({ messages: db.collections.messages })
)
const recent = allMessages.filter((m) => m.createdAt > cutoff)
```

Correct:

```typescript
const recent = useLiveQuery((q) =>
  q
    .from({ messages: db.collections.messages })
    .where(({ messages }) => gt(messages.createdAt, cutoff))
)
```

Using `array.filter()` recomputes on every change. TanStack DB's query builder uses differential dataflow — only affected rows recompute.

Source: TanStack DB architecture

### HIGH Assuming TanStack Query patterns transfer to TanStack DB

StreamDB uses TanStack DB under the hood. The APIs look similar to TanStack Query but have enough differences to cause errors. Use `useLiveQuery` (not `useQuery`), query builder syntax (not query keys), and collection-based mutations (not `useMutation`).

Source: Maintainer interview

### MEDIUM Missing awaitTxId for critical operations

Wrong:

```typescript
mutationFn: async (user) => {
  await stream.append(JSON.stringify(schema.users.insert({ value: user })))
  // No confirmation — optimistic update may not persist
},
```

Correct:

```typescript
mutationFn: async (user) => {
  const txid = crypto.randomUUID()
  await stream.append(
    JSON.stringify(
      schema.users.insert({ value: user, headers: { txid } })
    )
  )
  await db.utils.awaitTxId(txid, 10000)
},
```

Without `awaitTxId()`, the client has no confirmation of server-side persistence. The optimistic update may silently fail.

Source: packages/state/src/stream-db.ts — awaitTxId()

### MEDIUM Not calling close() on unmount

Wrong:

```typescript
// App unmounts, StreamDB connection persists indefinitely
```

Correct:

```typescript
// On app teardown
db.close()
```

StreamDB maintains an active stream subscription. Without `close()`, the connection persists after the app no longer needs data.

Source: packages/state/src/stream-db.ts — close()

### HIGH Tension: Protocol simplicity vs structured data needs

The base Durable Streams protocol is a raw byte stream. This package adds typed events, collections, and materialization on top. Agents optimizing for protocol simplicity use raw `JSON.stringify` with `append()` when they should use the State Protocol, losing type routing, upsert semantics, and reactive queries.

See also: durable-streams/SKILL.md § Common Mistakes

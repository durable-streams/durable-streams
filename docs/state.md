# State Protocol

Durable Streams gives you ordered, resumable byte delivery. The State Protocol adds semantic meaning on top: `insert`, `update`, and `delete` operations on typed entities. It provides the vocabulary you need for database-style sync -- presence tracking, chat rooms, feature flags, collaborative state -- without prescribing how you store or query that state.

- [Protocol Overview](#protocol-overview)
- [Installation](#installation)
- [Change Events](#change-events)
- [Control Events](#control-events)
- [MaterializedState](#materializedstate)
- [StreamDB with TanStack DB](#streamdb-with-tanstack-db)
- [Optimistic Actions](#optimistic-actions)
- [Common Patterns](#common-patterns)
- [Best Practices](#best-practices)
- [Durable Sessions](#durable-sessions)

## Protocol Overview

Durable Streams handles reliable delivery of bytes over HTTP. Many applications need more than raw bytes -- they need structured state changes with CRUD semantics. Rather than baking this into the core protocol, the State Protocol is a composable layer on top.

The protocol operates on JSON streams (`Content-Type: application/json`) and defines two message types:

- **Change messages** carry CRUD operations (`insert`, `update`, `delete`) on typed entities, each identified by a `type` discriminator and a `key`.
- **Control messages** manage stream lifecycle -- snapshot boundaries and resets.

Clients write change messages using the standard Durable Streams append operation and read them back as JSON arrays. State is materialized by applying these events sequentially: inserts add entities, updates replace them, deletes remove them. Multiple entity types can coexist in the same stream.

The protocol deliberately does not prescribe how state is stored (in-memory, IndexedDB, SQLite), how queries run, or how conflicts are resolved. These are left to implementations.

This separation means you adopt what you need:

- **AI token streaming?** Use Durable Streams directly -- tokens are a natural fit for an append-only byte stream.
- **Real-time database sync?** Add the State Protocol for typed collections with insert/update/delete operations.
- **Both in the same app?** Different streams can use different protocols. An AI response stream and a session state stream can coexist, each using the protocol that fits.

> See the full [State Protocol Specification](../packages/state/STATE-PROTOCOL.md) for the formal wire format and requirements.

## Installation

```bash
npm install @durable-streams/state @tanstack/db
```

`@tanstack/db` is a peer dependency required for StreamDB collections and reactive queries. If you only need `MaterializedState`, you can skip it.

## Change Events

The State Protocol defines a standard format for state change events. Each event targets a typed entity identified by `type` and `key`, and carries an operation in its `headers`:

```json
{
  "type": "user",
  "key": "user:123",
  "value": { "name": "Alice", "email": "alice@example.com" },
  "headers": {
    "operation": "insert",
    "txid": "abc-123",
    "timestamp": "2025-12-23T10:30:00Z"
  }
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Entity type discriminator -- routes events to the correct collection |
| `key` | Yes | Unique identifier for the entity within its type |
| `value` | For insert/update | The entity data |
| `old_value` | No | Previous value, useful for conflict detection |
| `headers.operation` | Yes | One of `"insert"`, `"update"`, or `"delete"` |
| `headers.txid` | No | Transaction identifier for confirmation |
| `headers.timestamp` | No | RFC 3339 timestamp |

Multiple entity types coexist in the same stream. A chat room stream might carry `user`, `message`, `reaction`, and `typing` events, all interleaved and processed in order.

## Control Events

The protocol also defines control events for stream management, separate from data changes. These have a `control` field in their headers instead of an `operation`:

| Control | Purpose |
|---------|---------|
| `snapshot-start` | Marks the beginning of a snapshot -- a complete dump of current state |
| `snapshot-end` | Marks the end of a snapshot boundary |
| `reset` | Signals clients to clear their materialized state and restart |

```json
{"headers": {"control": "snapshot-start", "offset": "123456_000"}}

{"type": "user", "key": "1", "value": {"name": "Alice"}, "headers": {"operation": "insert"}}
{"type": "user", "key": "2", "value": {"name": "Bob"}, "headers": {"operation": "insert"}}

{"headers": {"control": "snapshot-end", "offset": "123456_789"}}
```

You'll encounter these when a server sends a full state snapshot rather than incremental changes -- for example, on initial connection or after a schema migration.

## MaterializedState

`MaterializedState` is a simple in-memory key-value store that applies change events. It's the minimal way to consume state protocol events -- no schemas, no reactive queries, just a map from `(type, key)` to the latest value.

```typescript
import { MaterializedState } from "@durable-streams/state"

const state = new MaterializedState()

state.apply({
  type: "user",
  key: "1",
  value: { name: "Alice" },
  headers: { operation: "insert" },
})

state.apply({
  type: "user",
  key: "1",
  value: { name: "Alice Smith" },
  headers: { operation: "update" },
})

const user = state.get("user", "1")       // { name: "Alice Smith" }
const allUsers = state.getType("user")     // Map of all users
```

`MaterializedState` is a good fit when you need straightforward state tracking without reactive queries or schema validation.

## StreamDB with TanStack DB

For applications that need reactive queries, filtering, joins, and optimistic updates, `StreamDB` integrates the State Protocol with [TanStack DB](https://tanstack.com/db).

### Schema Definition

Define your state structure with `createStateSchema`. Each collection maps an entity type to a [Standard Schema](https://standardschema.dev/) validator and a primary key field:

```typescript
import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { z } from "zod"

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

const messageSchema = z.object({
  id: z.string(),
  userId: z.string(),
  text: z.string(),
  timestamp: z.string(),
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
```

Any [Standard Schema](https://standardschema.dev/) library works -- Zod, Valibot, ArkType, or a manual implementation:

```typescript
// Valibot
import * as v from "valibot"

const userSchema = v.object({
  id: v.string(),
  name: v.string(),
  email: v.pipe(v.string(), v.email()),
})
```

The schema also provides typed event creation helpers:

```typescript
schema.users.insert({ value: { id: "1", name: "Alice", email: "alice@example.com" } })
schema.users.update({ value: updatedUser, oldValue: previousUser })
schema.users.delete({ key: "1" })
```

### Creating a StreamDB

`createStreamDB` connects a schema to a Durable Stream, creating a reactive, stream-backed database:

```typescript
const db = createStreamDB({
  streamOptions: {
    url: "https://api.example.com/streams/my-stream",
    contentType: "application/json",
  },
  state: schema,
})

await db.preload()
```

Calling `preload()` reads the stream from the beginning and materializes all existing state into TanStack DB collections. The stream then stays connected for live updates.

### Reactive Queries

StreamDB collections are TanStack DB collections. Use `useLiveQuery` for reactive queries that automatically update when data changes:

```typescript
import { useLiveQuery } from "@tanstack/react-db"
import { eq, gt, and, count } from "@tanstack/db"

// All users
const allUsers = useLiveQuery((q) =>
  q.from({ users: db.collections.users })
)

// Filter
const activeUsers = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .where(({ users }) => eq(users.active, true))
)

// Sort and limit
const recentMessages = useLiveQuery((q) =>
  q
    .from({ messages: db.collections.messages })
    .orderBy(({ messages }) => messages.timestamp, "desc")
    .limit(50)
)

// Join across collections
const messagesWithAuthors = useLiveQuery((q) =>
  q
    .from({ messages: db.collections.messages })
    .join({ users: db.collections.users }, ({ messages, users }) =>
      eq(messages.userId, users.id)
    )
    .select(({ messages, users }) => ({
      text: messages.text,
      userName: users.name,
    }))
)
```

TanStack DB uses **differential dataflow** -- queries recompute incrementally when data changes rather than re-evaluating from scratch. Where possible, push filtering and sorting into the query builder rather than doing it in JavaScript.

Framework adapters are available for [React](https://tanstack.com/db/latest/docs/framework/react/overview), [Solid](https://tanstack.com/db/latest/docs/framework/solid/overview), and [Vue](https://tanstack.com/db/latest/docs/framework/vue/overview).

### Lifecycle

```typescript
await db.preload()                          // Load all data until up-to-date
db.close()                                  // Stop syncing and cleanup
await db.utils.awaitTxId("txid-uuid", 5000) // Wait for a transaction confirmation
```

## Optimistic Actions

StreamDB supports optimistic mutations through TanStack DB's action system. Actions update local state immediately while persisting changes to the stream asynchronously:

```typescript
const db = createStreamDB({
  streamOptions: { url: streamUrl, contentType: "application/json" },
  state: schema,
  actions: ({ db, stream }) => ({
    addUser: {
      onMutate: (user) => {
        db.collections.users.insert(user)
      },
      mutationFn: async (user) => {
        const txid = crypto.randomUUID()
        await stream.append(
          schema.users.insert({ value: user, headers: { txid } })
        )
        await db.utils.awaitTxId(txid)
      },
    },
  }),
})

await db.actions.addUser({ id: "1", name: "Alice", email: "alice@example.com" })
```

The `onMutate` callback runs synchronously to update the UI. The `mutationFn` persists the change to the stream and waits for confirmation via transaction ID. If the server mutation fails, TanStack DB automatically rolls back the optimistic update.

## Common Patterns

### Key/Value Store

```typescript
const schema = createStateSchema({
  config: {
    schema: configSchema,
    type: "config",
    primaryKey: "key",
  },
})

// Set a value
await stream.append(
  schema.config.insert({ value: { key: "theme", value: "dark" } })
)

// Query reactively
const themeQuery = useLiveQuery((q) =>
  q
    .from({ config: db.collections.config })
    .where(({ config }) => eq(config.key, "theme"))
    .findOne()
)
```

### Presence Tracking

```typescript
const schema = createStateSchema({
  presence: {
    schema: presenceSchema,
    type: "presence",
    primaryKey: "userId",
  },
})

// Update presence
await stream.append(
  schema.presence.update({
    value: { userId: "alice", status: "online", lastSeen: Date.now() },
  })
)

// Query online users
const onlineUsers = useLiveQuery((q) =>
  q
    .from({ presence: db.collections.presence })
    .where(({ presence }) => eq(presence.status, "online"))
)
```

### Multi-Type Chat Room

```typescript
const schema = createStateSchema({
  users: { schema: userSchema, type: "user", primaryKey: "id" },
  messages: { schema: messageSchema, type: "message", primaryKey: "id" },
  reactions: { schema: reactionSchema, type: "reaction", primaryKey: "id" },
  typing: { schema: typingSchema, type: "typing", primaryKey: "userId" },
})

// All types coexist in the same stream
await stream.append(schema.users.insert({ value: user }))
await stream.append(schema.messages.insert({ value: message }))
await stream.append(schema.reactions.insert({ value: reaction }))
```

## Best Practices

**Use object values.** StreamDB requires object values (not primitives) for the primary key pattern:

```typescript
// Won't work -- primitive value has no primary key field
{ type: "count", key: "views", value: 42 }

// Works -- object value with primary key
{ type: "count", key: "views", value: { id: "views", count: 42 } }
```

**Always call `close()`.** Clean up StreamDB instances to stop syncing and release resources:

```typescript
useEffect(() => {
  const db = createStreamDB({ streamOptions, state: schema })
  return () => db.close()
}, [])
```

**Use transaction IDs for critical operations.** Transaction IDs let you confirm that a write was applied:

```typescript
const txid = crypto.randomUUID()
await stream.append(
  schema.users.insert({ value: user, headers: { txid } })
)
await db.utils.awaitTxId(txid, 10000) // Wait up to 10 seconds
```

**Validate at boundaries.** Use Standard Schema to catch invalid data before it enters the stream:

```typescript
const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  age: z.number().min(0).max(150),
})
```

## Durable Sessions

A Durable Session multiplexes AI token streams with structured state into a persistent, shared session. Multiple users and agents can subscribe to and join the session at any time, making it a natural fit for collaborative AI applications.

The pattern layers protocols on top of each other:

1. **Durable Streams** -- reliable, resumable byte delivery
2. **State Protocol** -- structured CRUD operations over streams
3. **Application protocols** -- AI SDK transports, presence, CRDTs

This enables scenarios where an AI agent streams tokens into a session while structured state (tool results, user presence, shared documents) flows through the same infrastructure.

For a detailed walkthrough, see the [Durable Sessions for Collaborative AI](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai) blog post.

## Learn More

- [State Protocol Specification](../packages/state/STATE-PROTOCOL.md) -- full protocol spec
- [Package README](../packages/state/README.md) -- complete API reference
- [Examples](../examples/state/) -- background jobs dashboard and Wikipedia live events demo
- [TanStack DB](https://tanstack.com/db) -- reactive collections and query engine
- [Standard Schema](https://standardschema.dev/) -- schema validation

---

See also: [Core Concepts](concepts.md) | [Use Cases](use-cases.md) | [Clients](clients.md)

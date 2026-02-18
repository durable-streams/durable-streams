# State Protocol

Durable Streams gives you ordered, resumable byte delivery. The State Protocol adds semantic meaning on top: `insert`, `update`, and `delete` operations on typed entities. It provides the vocabulary you need for database-style sync -- presence tracking, chat rooms, feature flags, collaborative state -- without prescribing how you store or query that state.

## Why a Separate Protocol

Durable Streams handles reliable delivery of bytes over HTTP. Many applications need more than raw bytes -- they need structured state changes with CRUD semantics. Rather than baking this into the core protocol, the State Protocol is a composable layer on top.

This separation means you adopt what you need:

- **AI token streaming?** Use Durable Streams directly -- tokens are a natural fit for an append-only byte stream.
- **Real-time database sync?** Add the State Protocol for typed collections with insert/update/delete operations.
- **Both in the same app?** Different streams can use different protocols. An AI response stream and a session state stream can coexist, each using the protocol that fits.

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

The protocol also defines **control events** for stream management -- `snapshot-start`, `snapshot-end`, and `reset` signals that delimit snapshot boundaries or trigger state resets.

Multiple entity types coexist in the same stream. A chat room stream might carry `user`, `message`, `reaction`, and `typing` events, all interleaved and processed in order.

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

const schema = createStateSchema({
  users: {
    schema: userSchema,    // Standard Schema validator (Zod, Valibot, etc.)
    type: "user",          // Event type field
    primaryKey: "id",      // Primary key field name
  },
  messages: {
    schema: messageSchema,
    type: "message",
    primaryKey: "id",
  },
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

TanStack DB uses **differential dataflow** -- queries recompute incrementally when data changes rather than re-evaluating from scratch. This makes reactive queries dramatically faster than filtering in JavaScript, especially as data grows.

Framework adapters are available for [React](https://tanstack.com/db/latest/docs/framework/react/overview), [Solid](https://tanstack.com/db/latest/docs/framework/solid/overview), and [Vue](https://tanstack.com/db/latest/docs/framework/vue/overview).

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

## Durable Sessions

A Durable Session multiplexes AI token streams with structured state into a persistent, shared session. Multiple users and agents can subscribe to and join the session at any time, making it a natural fit for collaborative AI applications.

The pattern layers protocols on top of each other:

1. **Durable Streams** -- reliable, resumable byte delivery
2. **State Protocol** -- structured CRUD operations over streams
3. **Application protocols** -- AI SDK transports, presence, CRDTs

This enables scenarios where an AI agent streams tokens into a session while structured state (tool results, user presence, shared documents) flows through the same infrastructure.

For a detailed walkthrough, see the [Durable Sessions for Collaborative AI](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai) blog post. A reference implementation is available at [electric-sql/transport](https://github.com/electric-sql/transport).

## Examples

Working demos are available in [examples/state/](../examples/state/), including a Wikipedia events dashboard and background jobs example.

## Learn More

- [State Protocol Specification](../packages/state/STATE-PROTOCOL.md) -- full protocol spec
- [Package README](../packages/state/README.md) -- complete API reference
- [TanStack DB](https://tanstack.com/db) -- reactive collections and query engine
- [Standard Schema](https://standardschema.dev/) -- schema validation

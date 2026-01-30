---
name: durable-state
description: Guide for building real-time state synchronization with Durable Streams State Protocol. Use when implementing presence tracking, chat rooms, feature flags, collaborative editing, or any state that needs to sync across clients with reactive queries.
triggers:
  - "durable state"
  - "state protocol"
  - "MaterializedState"
  - "StreamDB"
  - "typed collections"
  - "reactive queries"
  - "presence"
  - "sync state"
metadata:
  sources:
    - "../../../state/src/index.ts"
    - "../../../state/src/materialized-state.ts"
    - "../../../state/src/stream-db.ts"
    - "../../../state/src/types.ts"
    - "../../../state/README.md"
    - "../../../state/STATE-PROTOCOL.md"
---

# Durable State

Building blocks for transmitting structured state over Durable Streams. Stream JSON state changes (insert/update/delete) and materialize them into queryable collections with reactive updates.

## When to Use Durable State

- **Presence tracking** - Real-time online status across users
- **Chat rooms** - Messages, reactions, typing indicators in one stream
- **Feature flags** - Real-time configuration propagation
- **Collaborative apps** - Shared state with optimistic updates
- **Database sync** - Stream database changes to client-side collections

## Installation

```bash
pnpm add @durable-streams/state @tanstack/db
```

> `@tanstack/db` is a peer dependency for reactive queries.

## Two Levels of Abstraction

| API                 | Use Case                                            |
| ------------------- | --------------------------------------------------- |
| `MaterializedState` | Simple in-memory state tracking                     |
| `StreamDB`          | Full reactive database with TanStack DB integration |

## Quick Start

### Simple State with MaterializedState

For basic state tracking without schemas:

```typescript
import { MaterializedState } from "@durable-streams/state"

const state = new MaterializedState()

// Apply change events
state.apply({
  type: "user",
  key: "1",
  value: { name: "Kyle" },
  headers: { operation: "insert" },
})

// Query state
const user = state.get("user", "1")
const allUsers = state.getType("user")
```

### Typed Collections with StreamDB

For production apps with schemas and reactive queries:

```typescript
import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { z } from "zod"

// 1. Define schema
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

const schema = createStateSchema({
  users: {
    schema: userSchema,
    type: "user", // Event type field
    primaryKey: "id", // Primary key field
  },
})

// 2. Create stream-backed database
const db = createStreamDB({
  streamOptions: {
    url: "https://api.example.com/streams/my-stream",
    contentType: "application/json",
  },
  state: schema,
})

// 3. Load initial data
await db.preload()

// 4. Query with TanStack DB
import { useLiveQuery } from "@tanstack/react-db"
import { eq } from "@tanstack/db"

const userQuery = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .where(({ users }) => eq(users.id, "123"))
    .findOne()
)
```

## State Protocol Events

The protocol defines standard change events:

### Insert

```typescript
{
  type: "user",
  key: "user:123",
  value: { name: "Alice", email: "alice@example.com" },
  headers: {
    operation: "insert",
    timestamp: "2025-01-15T10:30:00Z"  // Optional
  }
}
```

### Update

```typescript
{
  type: "user",
  key: "user:123",
  value: { name: "Alice Smith", email: "alice@example.com" },
  old_value: { name: "Alice", email: "alice@example.com" },  // Optional
  headers: { operation: "update" }
}
```

### Delete

```typescript
{
  type: "user",
  key: "user:123",
  old_value: { name: "Alice Smith", email: "alice@example.com" },  // Optional
  headers: { operation: "delete" }
}
```

### Control Events

```typescript
// Snapshot boundaries
{ headers: { control: "snapshot-start", offset: "123456_000" } }
{ headers: { control: "snapshot-end", offset: "123456_789" } }

// Reset signal - clients should clear state
{ headers: { control: "reset", offset: "123456_000" } }
```

## Schema Definition

### createStateSchema()

Define typed collections with validation:

```typescript
const schema = createStateSchema({
  users: {
    schema: userSchema, // Standard Schema validator (Zod, Valibot, etc.)
    type: "user", // Event type for routing
    primaryKey: "id", // Field to use as primary key
  },
  messages: {
    schema: messageSchema,
    type: "message",
    primaryKey: "id",
  },
})
```

### Schema Libraries

Uses [Standard Schema](https://standardschema.dev/) - works with Zod, Valibot, ArkType:

```typescript
// Zod
import { z } from "zod"
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
})

// Valibot
import * as v from "valibot"
const userSchema = v.object({
  id: v.string(),
  name: v.string(),
})
```

## Event Helpers

Schema provides typed event creation:

```typescript
// Insert
const event = schema.users.insert({
  value: { id: "1", name: "Kyle", email: "kyle@example.com" },
})

// Update
const event = schema.users.update({
  value: { id: "1", name: "Kyle Mathews", email: "kyle@example.com" },
  oldValue: { id: "1", name: "Kyle", email: "kyle@example.com" },
})

// Delete
const event = schema.users.delete({
  key: "1",
  oldValue: { id: "1", name: "Kyle", email: "kyle@example.com" },
})

// With transaction ID for confirmation
const event = schema.users.insert({
  value: { id: "1", name: "Kyle" },
  headers: { txid: crypto.randomUUID() },
})
```

## Reactive Queries with TanStack DB

StreamDB collections are TanStack DB collections with differential dataflow:

```typescript
import { useLiveQuery } from "@tanstack/react-db"
import { eq, gt, and, count } from "@tanstack/db"

// Simple query
const query = useLiveQuery((q) => q.from({ users: db.collections.users }))

// Filtering
const activeQuery = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .where(({ users }) => eq(users.active, true))
)

// Complex conditions
const query = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .where(({ users }) => and(eq(users.active, true), gt(users.age, 18)))
)

// Sorting and limiting
const topUsers = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .orderBy(({ users }) => users.lastSeen, "desc")
    .limit(10)
)

// Aggregation
const langStats = useLiveQuery((q) => {
  const counts = q
    .from({ events: db.collections.events })
    .groupBy(({ events }) => events.language)
    .select(({ events }) => ({
      language: events.language,
      total: count(events.id),
    }))

  return q.from({ stats: counts }).orderBy(({ stats }) => stats.total, "desc")
})

// Joins
const messagesWithUsers = useLiveQuery((q) =>
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

## Optimistic Actions

Define actions with optimistic updates:

```typescript
const db = createStreamDB({
  streamOptions: { url, contentType: "application/json" },
  state: schema,
  actions: ({ db, stream }) => ({
    addUser: {
      // Runs immediately (optimistic)
      onMutate: (user) => {
        db.collections.users.insert(user)
      },
      // Runs async (server mutation)
      mutationFn: async (user) => {
        const txid = crypto.randomUUID()
        await stream.append(
          JSON.stringify(
            schema.users.insert({
              value: user,
              headers: { txid },
            })
          )
        )
        await db.utils.awaitTxId(txid) // Wait for confirmation
      },
    },
  }),
})

// Call actions
await db.actions.addUser({ id: "1", name: "Kyle", email: "kyle@example.com" })
```

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

// Set value
await stream.append(
  JSON.stringify(
    schema.config.insert({
      value: { key: "theme", value: "dark" },
    })
  )
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
  JSON.stringify(
    schema.presence.update({
      value: { userId: "kyle", status: "online", lastSeen: Date.now() },
    })
  )
)

// Query online users
const onlineQuery = useLiveQuery((q) =>
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

// All types coexist in same stream
await stream.append(JSON.stringify(schema.users.insert({ value: user })))
await stream.append(JSON.stringify(schema.messages.insert({ value: message })))
await stream.append(
  JSON.stringify(schema.reactions.insert({ value: reaction }))
)
```

## Lifecycle

```typescript
// Load all data until up-to-date
await db.preload()

// Wait for transaction confirmation
await db.utils.awaitTxId("txid-uuid", 5000) // 5 second timeout

// Cleanup
db.close()

// React cleanup pattern
useEffect(() => {
  const db = createStreamDB({ streamOptions, state: schema })
  return () => db.close()
}, [])
```

## Common Mistakes

### Using primitive values

```typescript
// WRONG - primary key pattern requires objects
{ type: "count", key: "views", value: 42 }
```

```typescript
// CORRECT - wrap in object
{ type: "count", key: "views", value: { count: 42 } }
```

### Forgetting to close

```typescript
// WRONG - memory leak
const db = createStreamDB({ ... })
// Component unmounts without cleanup
```

```typescript
// CORRECT
useEffect(() => {
  const db = createStreamDB({ ... })
  return () => db.close()
}, [])
```

### Not awaiting txid for critical operations

```typescript
// WRONG - may show stale data
await stream.append(JSON.stringify(schema.users.insert({ value: user })))
// User might not be visible yet
```

```typescript
// CORRECT - wait for confirmation
const txid = crypto.randomUUID()
await stream.append(
  JSON.stringify(
    schema.users.insert({
      value: user,
      headers: { txid },
    })
  )
)
await db.utils.awaitTxId(txid)
```

### Filtering in JavaScript instead of query builder

```typescript
// WRONG - slow, recomputes on every change
const activeUsers = allUsers.filter((u) => u.active)
```

```typescript
// CORRECT - differential dataflow, only recomputes affected rows
const activeQuery = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .where(({ users }) => eq(users.active, true))
)
```

## Framework Integration

TanStack DB supports multiple frameworks:

- **React**: `@tanstack/react-db`
- **Solid**: `@tanstack/solid-db`
- **Vue**: `@tanstack/vue-db`

For detailed TanStack DB guidance, install the TanStack DB playbook:

```bash
npx @tanstack/db-playbook list
npx @tanstack/db-playbook show tanstack-db
```

## Additional Resources

- [State Protocol specification](../../../state/STATE-PROTOCOL.md)
- [TanStack DB playbook](https://www.npmjs.com/package/@tanstack/db-playbook) - Detailed TanStack DB skills
- [TanStack DB documentation](https://tanstack.com/db)
- [Standard Schema](https://standardschema.dev/)

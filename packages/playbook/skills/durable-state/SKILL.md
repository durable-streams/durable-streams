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

## SSR Warning

**Durable State requires client-only rendering.** `createStreamDB` fetches data at initialization, which fails during server-side rendering.

For TanStack Start/Router apps, wrap durable-state components with `clientOnly`:

```typescript
import { clientOnly$ } from "@tanstack/start"

const StreamDBProvider = clientOnly$(() => import("./StreamDBProvider"))
```

See `@electric-sql/playbook` for the `tanstack-start-quickstart` skill with full SSR configuration.

## Two Levels of Abstraction

| API                 | Use Case                                                  |
| ------------------- | --------------------------------------------------------- |
| `MaterializedState` | Simple testing/prototyping only                           |
| `StreamDB`          | **Recommended** - Full reactive database with TanStack DB |

**Use `StreamDB` for most use cases.** It provides typed collections, reactive queries, and optimistic updates. `MaterializedState` is a low-level primitive useful for testing or very simple scenarios where you don't need reactive queries.

## StreamDB Setup Pattern

**StreamDB is a stateful object that should be created as a global singleton.** It maintains a live connection to the stream and materializes state into queryable collections. Creating multiple instances wastes resources and causes state synchronization issues.

### Key Setup Requirements

1. **Create a single global instance** - StreamDB should be created once at module scope, not inside components
2. **Call `.preload()` before rendering** - Stream data must be loaded before components can query it
3. **Use route loaders or similar patterns** - Ensure preload completes before component rendering begins

### Recommended Setup Pattern

```typescript
// lib/db.ts - Create singleton at module scope
import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { z } from "zod"

const schema = createStateSchema({
  users: {
    schema: z.object({ id: z.string(), name: z.string() }),
    type: "user",
    primaryKey: "id",
  },
})

// Global singleton - created once, shared across components
export const db = createStreamDB({
  streamOptions: {
    url: "https://api.example.com/streams/my-stream",
    contentType: "application/json",
  },
  state: schema,
})

// Export preload function for route loaders
export const preloadDb = () => db.preload()
```

```typescript
// routes/users.tsx - Preload in route loader
import { createFileRoute } from "@tanstack/react-router"
import { db, preloadDb } from "../lib/db"

export const Route = createFileRoute("/users")({
  // Preload before component renders
  loader: async () => {
    await preloadDb()
  },
  component: UsersPage,
})

function UsersPage() {
  // Safe to query - data is already loaded
  const users = useLiveQuery((q) => q.from({ users: db.collections.users }))
  return <UserList users={users.data ?? []} />
}
```

### Why This Pattern Matters

- **Queries fail on empty state**: If you render components before `preload()` completes, queries return empty results or undefined
- **No loading states needed**: By preloading in route loaders, components render with data ready
- **Single source of truth**: One StreamDB instance ensures all components see consistent state

## Quick Start

### Simple State with MaterializedState

For basic testing or prototyping without schemas:

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
// Load all data until up-to-date (call before rendering components)
await db.preload()

// Wait for transaction confirmation
await db.utils.awaitTxId("txid-uuid", 5000) // 5 second timeout

// Cleanup (typically only needed when app unmounts)
db.close()
```

Since StreamDB should be a global singleton, cleanup is typically handled at the application level rather than in individual components. Call `db.close()` when the entire application unmounts or when you need to disconnect from the stream.

## Common Mistakes

### Using StreamDB during SSR

```typescript
// WRONG - fails during server-side rendering
// Error: "fetch failed" with no network error = SSR issue
const db = createStreamDB({ streamOptions, state: schema })
```

```typescript
// CORRECT - wrap in clientOnly for SSR frameworks
import { clientOnly$ } from "@tanstack/start"

const MyComponent = clientOnly$(() => import("./ClientOnlyComponent"))
```

### Using primitive values

```typescript
// WRONG - primary key pattern requires objects
{ type: "count", key: "views", value: 42 }
```

```typescript
// CORRECT - wrap in object
{ type: "count", key: "views", value: { count: 42 } }
```

### Creating StreamDB inside components

```typescript
// WRONG - creates new instance on every render, loses state
function MyComponent() {
  const db = createStreamDB({ streamOptions, state: schema })
  // ...
}
```

```typescript
// WRONG - creates new instance per component mount
useEffect(() => {
  const db = createStreamDB({ streamOptions, state: schema })
  return () => db.close()
}, [])
```

```typescript
// CORRECT - use a global singleton (see "StreamDB Setup Pattern" above)
// lib/db.ts
export const db = createStreamDB({ streamOptions, state: schema })

// Component.tsx
import { db } from "../lib/db"
function MyComponent() {
  const users = useLiveQuery((q) => q.from({ users: db.collections.users }))
}
```

### Querying before preload completes

```typescript
// WRONG - queries return empty/undefined before data is loaded
const db = createStreamDB({ streamOptions, state: schema })
// Immediately try to query without waiting
const users = useLiveQuery((q) => q.from({ users: db.collections.users }))
// users.data is undefined or empty!
```

```typescript
// CORRECT - preload in route loader before component renders
export const Route = createFileRoute("/users")({
  loader: async () => {
    await db.preload() // Wait for stream data
  },
  component: UsersPage,
})

function UsersPage() {
  // Data is ready, queries work immediately
  const users = useLiveQuery((q) => q.from({ users: db.collections.users }))
}
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

# @durable-streams/state

Building blocks for transmitting structured state over Durable Streams. Use these primitives for any real-time protocol: AI token streams, presence updates, collaborative editing, or database sync.

## Installation

```bash
pnpm add @durable-streams/state
```

## Overview

This package provides flexible primitives for streaming structured state. You choose how much structure you need:

- **Simple state updates**: Stream JSON payloads and track current values
- **Typed collections**: Add schemas and primary keys for structured entities
- **Reactive queries**: Build on TanStack DB for subscriptions and optimistic updates

Stream whatever state your protocol requires.

## Quick Start

### Simple State

Stream structured JSON and query current values:

```typescript
import { MaterializedState } from "@durable-streams/state"

const state = new MaterializedState()

// Apply any structured change
state.apply({
  type: "token",
  key: "stream-1",
  value: { content: "Hello", model: "claude-3" },
  headers: { operation: "insert" },
})

// Query current state
const token = state.get("token", "stream-1")
const allTokens = state.getType("token")
```

### Typed Collections

Add schemas and validation for structured entities:

```typescript
import { createStateSchema, createStreamDB } from "@durable-streams/state"

// Define your schema
const schema = createStateSchema({
  users: {
    schema: userSchema, // Standard Schema validator
    type: "user", // Event type field
    primaryKey: "id", // Primary key field name
  },
  messages: {
    schema: messageSchema,
    type: "message",
    primaryKey: "id",
  },
})

// Create a stream-backed database
const db = await createStreamDB({
  streamOptions: {
    url: "https://api.example.com/streams/my-stream",
    contentType: "application/json",
  },
  state: schema,
})

// Load initial data
await db.preload()

// Reactive queries with useLiveQuery
import { useLiveQuery } from "@tanstack/react-db" // or solid-db, vue-db
import { eq } from "@tanstack/db"

const userQuery = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .where(({ users }) => eq(users.id, "123"))
    .findOne()
)

const allUsersQuery = useLiveQuery((q) =>
  q.from({ users: db.collections.users })
)
```

## Core Concepts

### State Protocol

The Durable Streams State Protocol defines a standard format for state change events:

- **Change Events**: `insert`, `update`, `delete` operations on entities
- **Control Events**: `snapshot-start`, `snapshot-end`, `reset` signals
- **Entity Types**: Discriminator field that routes events to collections
- **Primary Keys**: Unique identifiers extracted from entity values

See [STATE-PROTOCOL.md](./STATE-PROTOCOL.md) for the full specification.

### MaterializedState

Simple in-memory state container for basic use cases:

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

### StreamDB

Stream-backed database with TanStack DB collections. Provides reactive queries, subscriptions, and optimistic updates.

## Schema Definition

### createStateSchema()

Define your application state structure:

```typescript
const schema = createStateSchema({
  users: {
    schema: userSchema, // Standard Schema validator
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

### Standard Schema Support

Uses [Standard Schema](https://standardschema.dev/) for validation, supporting multiple libraries:

```typescript
// Zod
import { z } from "zod"

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

// Valibot
import * as v from "valibot"

const userSchema = v.object({
  id: v.string(),
  name: v.string(),
  email: v.pipe(v.string(), v.email()),
})

// Manual Standard Schema
const userSchema = {
  "~standard": {
    version: 1,
    vendor: "my-app",
    validate: (value) => {
      // Your validation logic
      if (isValid(value)) {
        return { value }
      }
      return { issues: [{ message: "Invalid user" }] }
    },
  },
}
```

## Event Helpers

Schema provides typed event creation helpers:

```typescript
// Insert
const insertEvent = schema.users.insert({
  value: { id: "1", name: "Kyle", email: "kyle@example.com" },
  key: "1", // Optional, defaults to value[primaryKey]
})

// Update
const updateEvent = schema.users.update({
  value: { id: "1", name: "Kyle Mathews", email: "kyle@example.com" },
  oldValue: { id: "1", name: "Kyle", email: "kyle@example.com" }, // Optional
})

// Delete
const deleteEvent = schema.users.delete({
  key: "1",
  oldValue: { id: "1", name: "Kyle", email: "kyle@example.com" }, // Optional
})

// Custom headers
const eventWithTxId = schema.users.insert({
  value: { id: "1", name: "Kyle" },
  headers: {
    txid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  },
})
```

## StreamDB

### Creating a Database

```typescript
const db = await createStreamDB({
  streamOptions: {
    url: "https://api.example.com/streams/my-stream",
    contentType: "application/json",
    // All DurableStream options supported
    headers: { Authorization: "Bearer token" },
    batching: true,
  },
  state: schema,
})

// The stream is created lazily when preload() is called
await db.preload()
```

### Reactive Queries with TanStack DB

StreamDB collections are TanStack DB collections. Use TanStack DB's query builder for filtering, sorting, aggregation, and joins with **differential dataflow** - dramatically faster than JavaScript filtering:

```typescript
import { useLiveQuery } from "@tanstack/[framework]-db" // react-db, solid-db, etc
import { eq, gt, and, count } from "@tanstack/db"

// Simple collection access
const query = useLiveQuery((q) => q.from({ users: db.collections.users }))

// Filtering with WHERE
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
const topUsersQuery = useLiveQuery((q) =>
  q
    .from({ users: db.collections.users })
    .orderBy(({ users }) => users.lastSeen, "desc")
    .limit(10)
)

// Aggregation with GROUP BY and ordering
const langStatsQuery = useLiveQuery((q) => {
  const languageCounts = q
    .from({ events: db.collections.events })
    .groupBy(({ events }) => events.language)
    .select(({ events }) => ({
      language: events.language,
      total: count(events.id),
    }))

  return q
    .from({ stats: languageCounts })
    .orderBy(({ stats }) => stats.total, "desc")
})

// Joins across collections
const query = useLiveQuery((q) =>
  q
    .from({ messages: db.collections.messages })
    .join({ users: db.collections.users }, ({ messages, users }) =>
      eq(messages.userId, users.id)
    )
    .select(({ messages, users }) => ({
      messageId: messages.id,
      text: messages.text,
      userName: users.name,
    }))
)
```

**Why use the query builder?**

- **Differential dataflow**: Incremental updates only recompute affected results
- **Dramatically faster**: Push filtering/sorting into the DB engine vs JavaScript
- **Reactive**: Queries automatically update when data changes
- **Type-safe**: Full TypeScript support with autocomplete

**Framework integration**: See [TanStack DB docs](https://tanstack.com/db) for framework-specific guides:

- [@tanstack/react-db](https://tanstack.com/db/latest/docs/framework/react/overview)
- [@tanstack/solid-db](https://tanstack.com/db/latest/docs/framework/solid/overview)
- [@tanstack/vue-db](https://tanstack.com/db/latest/docs/framework/vue/overview)

### Lifecycle Methods

```typescript
// Load all data until up-to-date
await db.preload()

// Stop syncing and cleanup
db.close()

// Wait for a transaction to be confirmed
await db.utils.awaitTxId("txid-uuid", 5000) // 5 second timeout
```

## Optimistic Actions

Define actions with optimistic updates and server confirmation:

```typescript
const db = await createStreamDB({
  streamOptions: { url: streamUrl, contentType: "application/json" },
  state: schema,
  actions: ({ db, stream }) => ({
    addUser: {
      // Optimistic update (runs immediately)
      onMutate: (user) => {
        db.collections.users.insert(user)
      },
      // Server mutation (runs async)
      mutationFn: async (user) => {
        const txid = crypto.randomUUID()

        await stream.append(
          schema.users.insert({
            value: user,
            headers: { txid },
          })
        )

        // Wait for confirmation
        await db.utils.awaitTxId(txid)
      },
    },

    updateUser: {
      onMutate: ({ id, updates }) => {
        db.collections.users.update(id, (draft) => {
          Object.assign(draft, updates)
        })
      },
      mutationFn: async ({ id, updates }) => {
        const txid = crypto.randomUUID()
        const current = await db.collections.users.get(id)

        await stream.append(
          schema.users.update({
            value: { ...current, ...updates },
            oldValue: current,
            headers: { txid },
          })
        )

        await db.utils.awaitTxId(txid)
      },
    },
  }),
})

// Call actions
await db.actions.addUser({ id: "1", name: "Kyle", email: "kyle@example.com" })
await db.actions.updateUser({ id: "1", updates: { name: "Kyle Mathews" } })
```

## Framework Integration

Use TanStack DB's framework adapters for reactive queries:

### React

```typescript
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'

function UserProfile({ userId }: { userId: string }) {
  const userQuery = useLiveQuery((q) =>
    q.from({ users: db.collections.users })
      .where(({ users }) => eq(users.id, userId))
      .findOne()
  )

  if (userQuery.isLoading()) return <div>Loading...</div>
  if (!userQuery.data) return <div>Not found</div>

  return (
    <div>
      <h1>{userQuery.data.name}</h1>
      <p>{userQuery.data.email}</p>
    </div>
  )
}
```

See [@tanstack/react-db docs](https://tanstack.com/db/latest/docs/framework/react/overview) for more.

### Solid.js

```typescript
import { useLiveQuery } from '@tanstack/solid-db'
import { eq } from '@tanstack/db'

function MessageList() {
  const messagesQuery = useLiveQuery((q) =>
    q.from({ messages: db.collections.messages })
      .orderBy(({ messages }) => messages.timestamp, 'desc')
      .limit(50)
  )

  return (
    <For each={messagesQuery.data}>
      {(message) => <MessageCard message={message} />}
    </For>
  )
}
```

See [@tanstack/solid-db docs](https://tanstack.com/db/latest/docs/framework/solid/overview) for more.

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
  schema.config.insert({
    value: { key: "theme", value: "dark" },
  })
)

// Query value reactively
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
    value: {
      userId: "kyle",
      status: "online",
      lastSeen: Date.now(),
    },
  })
)

// Query presence with TanStack DB
const presenceQuery = useLiveQuery((q) =>
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

// Different types coexist in the same stream
await stream.append(schema.users.insert({ value: user }))
await stream.append(schema.messages.insert({ value: message }))
await stream.append(schema.reactions.insert({ value: reaction }))
```

## Best Practices

### 1. Use Object Values

StreamDB requires object values (not primitives) for the primary key pattern:

```typescript
// ❌ Won't work
{ type: 'count', key: 'views', value: 42 }

// ✅ Works
{ type: 'count', key: 'views', value: { count: 42 } }
```

### 2. Always Call close()

```typescript
useEffect(() => {
  const db = createStreamDB({ streamOptions, state: schema })

  return () => db.close() // Cleanup on unmount
}, [])
```

### 3. Validate at Boundaries

Use Standard Schema to validate data at system boundaries:

```typescript
const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  age: z.number().min(0).max(150),
})
```

### 4. Use Transaction IDs

For critical operations, always use transaction IDs to ensure confirmation:

```typescript
const txid = crypto.randomUUID()
await stream.append(schema.users.insert({ value: user, headers: { txid } }))
await db.utils.awaitTxId(txid, 10000) // Wait up to 10 seconds
```

### 5. Handle Errors Gracefully

```typescript
try {
  await db.actions.addUser(user)
} catch (error) {
  if (error.message.includes("Timeout")) {
    // Handle timeout
  } else {
    // Handle other errors
  }
}
```

## API Reference

### Types

```typescript
export type Operation = "insert" | "update" | "delete"

export interface ChangeEvent<T = unknown> {
  type: string
  key: string
  value?: T
  old_value?: T
  headers: ChangeHeaders
}

export interface ChangeHeaders {
  operation: Operation
  txid?: string
  timestamp?: string
}

export interface ControlEvent {
  headers: {
    control: "snapshot-start" | "snapshot-end" | "reset"
    offset?: string
  }
}

export type StateEvent<T = unknown> = ChangeEvent<T> | ControlEvent
```

### Functions

```typescript
// Create a state schema with typed collections and event helpers
export function createStateSchema<
  T extends Record<string, CollectionDefinition>,
>(collections: T): StateSchema<T>

// Create a stream-backed database
export async function createStreamDB<
  TDef extends StreamStateDefinition,
  TActions extends Record<string, ActionDefinition<any>>,
>(
  options: CreateStreamDBOptions<TDef, TActions>
): Promise<StreamDB<TDef> | StreamDBWithActions<TDef, TActions>>
```

### Classes

```typescript
export class MaterializedState {
  apply(event: ChangeEvent): void
  applyBatch(events: ChangeEvent[]): void
  get<T>(type: string, key: string): T | undefined
  getType(type: string): Map<string, unknown>
  clear(): void
  readonly typeCount: number
  readonly types: string[]
}
```

## License

Apache-2.0

## Learn More

- [STATE-PROTOCOL.md](./STATE-PROTOCOL.md) - Full protocol specification
- [Durable Streams Protocol](../../PROTOCOL.md) - Base protocol
- [Standard Schema](https://standardschema.dev/) - Schema validation
- [TanStack DB](https://tanstack.com/db) - Reactive collections

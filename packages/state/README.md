# @durable-streams/state

State synchronization protocol for Durable Streams. Build real-time applications with database-style semantics over append-only streams.

## Installation

```bash
pnpm add @durable-streams/state
```

## Quick Start

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

// Query with TanStack DB
const user = await db.collections.users.get("123")
const allUsers = await db.collections.users.findAll()

// Subscribe to changes
db.collections.users.subscribe("123", (user) => {
  console.log("User updated:", user)
})
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

### Querying Collections

StreamDB exposes TanStack DB collections under `db.collections.*`:

```typescript
// Get by key
const user = await db.collections.users.get("123")

// Get all
const allUsers = await db.collections.users.findAll()

// Find many with filter
const activeUsers = await db.collections.users.findMany({
  where: (user) => user.active === true,
})

// Check size
const count = db.collections.users.size
```

### Subscriptions

```typescript
// Subscribe to a specific entity
const unsubscribe = db.collections.users.subscribe("123", (user) => {
  console.log("User changed:", user)
})

// Subscribe to all changes
db.collections.users.subscribeChanges((changes) => {
  for (const change of changes) {
    console.log(`${change.type}: ${change.key}`, change.value)
  }
})

// Cleanup
unsubscribe()
```

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

## React Integration

```typescript
import { useSyncExternalStore } from 'react'

function useUser(id: string) {
  return useSyncExternalStore(
    (callback) => {
      const unsubscribe = db.collections.users.subscribe(id, callback)
      return unsubscribe
    },
    () => db.collections.users.get(id)
  )
}

function UserProfile({ userId }: { userId: string }) {
  const user = useUser(userId)

  if (!user) return <div>Loading...</div>

  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  )
}
```

Or with TanStack Query:

```typescript
import { useMutation, useQuery } from '@tanstack/react-query'

function useAddUser() {
  return useMutation({
    mutationFn: db.actions.addUser,
  })
}

function AddUserButton() {
  const addUser = useAddUser()

  return (
    <button
      onClick={() => addUser.mutate({ id: '1', name: 'Kyle' })}
      disabled={addUser.isPending}
    >
      Add User
    </button>
  )
}
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
  schema.config.insert({
    value: { key: "theme", value: "dark" },
  })
)

// Get value
const theme = await db.collections.config.get("theme")
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

// Watch presence
db.collections.presence.subscribe("kyle", (presence) => {
  console.log(`Kyle is ${presence.status}`)
})
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

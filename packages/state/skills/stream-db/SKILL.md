---
name: stream-db
description: >
  Stream-backed reactive database with @durable-streams/state. createStreamDB()
  with schema and stream options, db.preload() lazy initialization,
  db.collections for TanStack DB collections, optimistic actions with onMutate
  and mutationFn, db.utils.awaitTxId() for transaction confirmation, control
  events (snapshot-start, snapshot-end, reset), db.close() cleanup, re-exported
  TanStack DB operators (eq, gt, and, or, count, sum, avg, min, max).
type: core
library: durable-streams
library_version: "0.2.1"
requires:
  - state-schema
sources:
  - "durable-streams/durable-streams:packages/state/src/stream-db.ts"
  - "durable-streams/durable-streams:packages/state/README.md"
---

This skill builds on durable-streams/state-schema. Read it first for schema definition and event types.

# Durable Streams — StreamDB

Create a stream-backed reactive database that syncs structured state from a
durable stream into TanStack DB collections. Provides reactive queries,
optimistic actions, and transaction confirmation.

## Setup

```typescript
import { createStreamDB, createStateSchema } from "@durable-streams/state"
import { DurableStream } from "@durable-streams/client"
import { z } from "zod"

const schema = createStateSchema({
  users: {
    schema: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    type: "user",
    primaryKey: "id",
  },
  messages: {
    schema: z.object({ id: z.string(), text: z.string(), userId: z.string() }),
    type: "message",
    primaryKey: "id",
  },
})

const db = createStreamDB({
  streamOptions: {
    url: "https://your-server.com/v1/stream/my-app",
    contentType: "application/json",
  },
  state: schema,
})

// The stream must already exist on the server before preload().
// Use DurableStream.connect() to attach to an existing stream,
// or create it first if it doesn't exist yet:
try {
  await DurableStream.create({
    url: "https://your-server.com/v1/stream/my-app",
    contentType: "application/json",
  })
} catch (e) {
  if (e.code !== "CONFLICT_EXISTS") throw e // Already exists is fine
}

// Connect and load initial data
await db.preload()

// Access TanStack DB collections
const users = db.collections.users
const messages = db.collections.messages
```

## Core Patterns

### Reactive queries with TanStack DB

StreamDB collections are TanStack DB collections. Use framework adapters for reactive queries.

**IMPORTANT**: `useLiveQuery` returns `{ data }`, NOT the array directly. Always destructure with a default:

```typescript
import { useLiveQuery } from "@tanstack/react-db"
import { eq } from "@durable-streams/state"

// List query — destructure { data } with a default empty array
function UserList() {
  const { data: users = [] } = useLiveQuery((q) =>
    q.from({ users: db.collections.users })
  )

  return users.map(u => <div key={u.id}>{u.name}</div>)
}

// Single item query — use findOne(), data is T | undefined
function UserProfile({ userId }: { userId: string }) {
  const { data: user } = useLiveQuery((q) =>
    q
      .from({ users: db.collections.users })
      .where(({ users }) => eq(users.id, userId))
      .findOne()
  )

  if (!user) return null
  return <div>{user.name}</div>
}
```

### Optimistic actions with server confirmation

```typescript
import { createStreamDB, createStateSchema } from "@durable-streams/state"
import { z } from "zod"

const schema = createStateSchema({
  users: {
    schema: z.object({ id: z.string(), name: z.string() }),
    type: "user",
    primaryKey: "id",
  },
})

const db = createStreamDB({
  streamOptions: {
    url: "https://your-server.com/v1/stream/my-app",
    contentType: "application/json",
  },
  state: schema,
  actions: ({ db, stream }) => ({
    addUser: {
      onMutate: (user) => {
        db.collections.users.insert(user) // Optimistic — shows immediately
      },
      mutationFn: async (user) => {
        const txid = crypto.randomUUID()
        await stream.append(
          JSON.stringify(
            schema.users.insert({ value: user, headers: { txid } })
          )
        )
        await db.utils.awaitTxId(txid, 10000) // Wait for confirmation
      },
    },
  }),
})

await db.preload()
await db.actions.addUser({ id: "1", name: "Kyle" })
```

### Cleanup on unmount

```typescript
import { useEffect, useState } from "react"

function App() {
  const [db, setDb] = useState(null)

  useEffect(() => {
    const database = createStreamDB({ streamOptions, state: schema })
    database.preload().then(() => setDb(database))
    return () => database.close()  // Clean up connections and timers
  }, [])

  if (!db) return <div>Loading...</div>
  return <Dashboard db={db} />
}
```

### SSR: StreamDB is client-only

StreamDB holds open HTTP connections and relies on browser/Node.js runtime features. In meta-frameworks (TanStack Start, Next.js, Remix), ensure StreamDB only runs on the client:

```typescript
// TanStack Start / React Router — mark the route as client-only
export const Route = createFileRoute("/dashboard")({
  ssr: false,
  component: Dashboard,
})
```

Without `ssr: false`, the server-side render will attempt to create StreamDB and fail or produce `instanceof` mismatches between server and client bundles.

## Common Mistakes

### CRITICAL Forgetting to call preload() before accessing data

Wrong:

```typescript
const db = createStreamDB({ streamOptions, state: schema })
const users = db.collections.users // Collections are empty!
```

Correct:

```typescript
const db = createStreamDB({ streamOptions, state: schema })
await db.preload() // Connect and load initial data
const users = db.collections.users
```

StreamDB creates the stream lazily. Without `preload()`, no connection is established and collections remain empty.

Source: packages/state/src/stream-db.ts

### HIGH Not calling close() on unmount/cleanup

Wrong:

```typescript
useEffect(() => {
  const db = createStreamDB({ streamOptions, state: schema })
  db.preload()
  setDb(db)
}, [])
```

Correct:

```typescript
useEffect(() => {
  const db = createStreamDB({ streamOptions, state: schema })
  db.preload()
  setDb(db)
  return () => db.close()
}, [])
```

StreamDB holds open HTTP connections and a 15-second health check interval. Forgetting `close()` leaks connections and timers.

Source: packages/state/README.md best practices

### HIGH Not using awaitTxId for critical writes

Wrong:

```typescript
mutationFn: async (user) => {
  await stream.append(JSON.stringify(schema.users.insert({ value: user })))
  // No confirmation — optimistic state may diverge from server
}
```

Correct:

```typescript
mutationFn: async (user) => {
  const txid = crypto.randomUUID()
  await stream.append(
    JSON.stringify(schema.users.insert({ value: user, headers: { txid } }))
  )
  await db.utils.awaitTxId(txid, 10000) // Wait up to 10 seconds
}
```

Without `awaitTxId`, the client has no confirmation that the write was persisted. Optimistic state may diverge if the write fails silently.

Source: packages/state/README.md transaction IDs section

### HIGH Tension: Catch-up completeness vs. live latency

This skill's patterns conflict with reading-streams. `preload()` waits for all existing data before resolving, which may take time for large streams. Agents may forget that after `preload()`, the StreamDB is already in live-tailing mode — no additional subscription setup is needed.

See also: durable-streams/reading-streams/SKILL.md

## See also

- [state-schema](../state-schema/SKILL.md) — Define schemas before creating a StreamDB
- [reading-streams](../../../client/skills/reading-streams/SKILL.md) — Understanding live modes and offset management

## Version

Targets @durable-streams/state v0.2.1.

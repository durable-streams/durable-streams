---
name: state-schema
description: >
  Defining typed state schemas for @durable-streams/state. createStateSchema()
  with CollectionDefinition (schema, type, primaryKey), Standard Schema
  validators (Zod, Valibot, ArkType), event helpers insert/update/delete/upsert,
  ChangeEvent and ControlEvent types, State Protocol operations, transaction
  IDs (txid) for write confirmation. Load when defining entity types, choosing
  a schema validator, or creating typed change events.
type: core
library: durable-streams
library_version: "0.2.1"
sources:
  - "durable-streams/durable-streams:packages/state/src/stream-db.ts"
  - "durable-streams/durable-streams:packages/state/src/types.ts"
  - "durable-streams/durable-streams:packages/state/STATE-PROTOCOL.md"
  - "durable-streams/durable-streams:packages/state/README.md"
---

# Durable Streams — State Schema

Define typed entity collections over durable streams using Standard Schema
validators. Schemas route stream events to collections, validate data, and
provide typed helpers for creating change events.

## Setup

```typescript
import { createStateSchema } from "@durable-streams/state"
import { z } from "zod" // Use the correct import for your Zod version (e.g. "zod/v4" for Zod v4)

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

const messageSchema = z.object({
  id: z.string(),
  text: z.string(),
  userId: z.string(),
  timestamp: z.number(),
})

const schema = createStateSchema({
  users: {
    schema: userSchema,
    type: "user", // Event type field — routes events to this collection
    primaryKey: "id", // Field in value used as unique key
  },
  messages: {
    schema: messageSchema,
    type: "message",
    primaryKey: "id",
  },
})
```

## Core Patterns

### Creating typed change events

Schema collections provide typed helpers for building events:

```typescript
// Insert
const insertEvent = schema.users.insert({
  value: { id: "1", name: "Kyle", email: "kyle@example.com" },
})

// Update
const updateEvent = schema.users.update({
  value: { id: "1", name: "Kyle Mathews", email: "kyle@example.com" },
  oldValue: { id: "1", name: "Kyle", email: "kyle@example.com" },
})

// Delete
const deleteEvent = schema.users.delete({
  key: "1",
  oldValue: { id: "1", name: "Kyle", email: "kyle@example.com" },
})
```

### Using transaction IDs for confirmation

```typescript
const txid = crypto.randomUUID()

const event = schema.users.insert({
  value: { id: "1", name: "Kyle", email: "kyle@example.com" },
  headers: { txid },
})

await stream.append(event)
// Then use db.utils.awaitTxId(txid) in StreamDB for confirmation
```

### Choosing a schema validator

Any library implementing [Standard Schema](https://standardschema.dev/) works:

```typescript
// Zod
import { z } from "zod"
const userSchema = z.object({ id: z.string(), name: z.string() })

// Valibot
import * as v from "valibot"
const userSchema = v.object({ id: v.string(), name: v.string() })

// Manual Standard Schema implementation
const userSchema = {
  "~standard": {
    version: 1,
    vendor: "my-app",
    validate: (value) => {
      if (typeof value === "object" && value !== null && "id" in value) {
        return { value }
      }
      return { issues: [{ message: "Invalid user" }] }
    },
  },
}
```

### Event types and type guards

```typescript
import { isChangeEvent, isControlEvent } from "@durable-streams/state"
import type {
  StateEvent,
  ChangeEvent,
  ControlEvent,
} from "@durable-streams/state"

function handleEvent(event: StateEvent) {
  if (isChangeEvent(event)) {
    // event.type, event.key, event.value, event.headers.operation
    console.log(`${event.headers.operation}: ${event.type}/${event.key}`)
  }
  if (isControlEvent(event)) {
    // event.headers.control: "snapshot-start" | "snapshot-end" | "reset"
    console.log(`Control: ${event.headers.control}`)
  }
}
```

## Common Mistakes

### CRITICAL Using primitive values instead of objects in collections

Wrong:

```typescript
{ type: "count", key: "views", value: 42 }
```

Correct:

```typescript
{ type: "count", key: "views", value: { count: 42 } }
```

Collections require object values so the `primaryKey` field can be extracted. Primitive values throw during dispatch.

Source: packages/state/README.md best practices

### HIGH Using duplicate event types across collections

Wrong:

```typescript
createStateSchema({
  users: { schema: userSchema, type: "entity", primaryKey: "id" },
  posts: { schema: postSchema, type: "entity", primaryKey: "id" },
})
```

Correct:

```typescript
createStateSchema({
  users: { schema: userSchema, type: "user", primaryKey: "id" },
  posts: { schema: postSchema, type: "post", primaryKey: "id" },
})
```

`createStateSchema()` throws if two collections share the same `type` string. The `type` field routes events to collections — duplicates would be ambiguous.

Source: packages/state/src/stream-db.ts createStateSchema validation

### HIGH Forgetting to use a Standard Schema-compatible validator

Wrong:

```typescript
interface User {
  id: string
  name: string
}
createStateSchema({
  users: { schema: User, type: "user", primaryKey: "id" }, // Not a validator!
})
```

Correct:

```typescript
import { z } from "zod"
const userSchema = z.object({ id: z.string(), name: z.string() })
createStateSchema({
  users: { schema: userSchema, type: "user", primaryKey: "id" },
})
```

The `schema` field requires an object implementing the `~standard` interface. TypeScript interfaces and plain types are not validators.

Source: packages/state/README.md Standard Schema support section

### MEDIUM Using reserved collection names

Wrong:

```typescript
createStateSchema({
  actions: { schema: actionSchema, type: "action", primaryKey: "id" },
})
```

Correct:

```typescript
createStateSchema({
  userActions: { schema: actionSchema, type: "action", primaryKey: "id" },
})
```

Collection names `collections`, `preload`, `close`, `utils`, and `actions` are reserved — they collide with the StreamDB API surface.

Source: packages/state/src/stream-db.ts reserved name check

### HIGH Tension: Schema strictness vs. prototyping speed

This skill's patterns conflict with getting-started. The state package requires Standard Schema validators and typed collections, while quick prototyping favors raw JSON streams without schemas. Agents may jump to StreamDB for a simple demo when raw `stream()` with JSON mode would be faster.

See also: durable-streams/getting-started/SKILL.md

## See also

- [stream-db](../stream-db/SKILL.md) — Wire schemas into a reactive StreamDB

## Version

Targets @durable-streams/state v0.2.1.

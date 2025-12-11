# RFC: @durable-streams/state - Composable State Change Protocol

## Vision

Provide a composable schema for state change events (insert/update/delete) that any protocol can adopt when it needs database-style sync semantics. This creates a shared vocabulary for state synchronization that works across different transport layers, storage backends, and application patterns.

## Why This Matters

Just as Redis is a data structures server, this is a **data structures sync server**. Build custom data structures that automatically synchronize across clients with:

- **End-to-end type safety** - From server-side event generation through stream transport to client-side materialization, types flow through the entire system
- **Custom schemas** - Use Standard Schema to define and validate your domain models with any schema library (Zod, Valibot, ArkType)
- **Lightweight & fast** - Stream change events directly rather than syncing through a heavyweight database. Simple append-only protocol with automatic client-side materialization
- **Flexible composition** - Mix and match different entity types in a single stream, combine multiple streams, or split concerns across streams as needed
- **Proven patterns** - Build presence systems, chat applications, collaborative editing, real-time dashboards using battle-tested change event semantics

Rather than building bespoke sync protocols for each feature, developers can leverage a common foundation that handles the hard parts (event ordering, schema validation, state materialization) while maintaining full flexibility over application logic.

## Architectural Position

```
┌─────────────────────────────────────────────┐
│  Application Protocols                      │
│  (presence, chat, kanban, feature flags)    │
├─────────────────────────────────────────────┤
│  Database Adapters & AI Plugins             │
│  (TanStack DB, Postgres, Redis, LLMs)       │
├─────────────────────────────────────────────┤
│  State Protocol (@durable-streams/state)    │  ← This package
│  - Change events (insert/update/delete)     │
│  - Materialized state                       │
│  - Schema validation                        │
├─────────────────────────────────────────────┤
│  Durable Streams (transport layer)          │
└─────────────────────────────────────────────┘
```

The state protocol sits between raw streams and application protocols, providing reusable primitives for state synchronization.

## Use Cases

The protocol enables eight primary patterns:

1. **Key/Value Store** - Simple synced entries with TTL and optimistic updates
2. **Presence Tracking** - Real-time online status with heartbeat timeouts
3. **Chat Rooms** - Multi-type streams (users, messages, reactions, receipts)
4. **Feature Flags** - Real-time configuration propagation with rollouts
5. **Kanban Boards** - Collaborative task management with drag-and-drop
6. **Notification Feeds** - Per-user notifications with read/unread state
7. **Audit Logs** - Insert-only immutable event records
8. **Shopping Carts** - Cross-device synchronization with inventory

Each pattern shares the same underlying change event structure but applies it differently.

## Core Abstractions

### Change Events

```typescript
interface ChangeMessage<T> {
  type: string // Entity type discriminator
  key: string // Entity identifier
  value: T // New value
  old_value?: T // Previous value (optional)
  headers: {
    operation: "insert" | "update" | "delete"
    timestamp?: string
    txid?: string
  }
}
```

### Control Events

Stream management signals (up-to-date, snapshot boundaries, reset) separate from data changes.

### Materialized State

In-memory state container that applies change events sequentially:

```typescript
const state = new MaterializedState()
state.apply(changeEvent) // Apply single event
state.applyBatch(events) // Batch application
state.get(type, key) // Query by type and key
state.getType(type) // Get all entities of a type
```

### Schema Definition

```typescript
defineStreamSchema({
  types: {
    user: userSchema, // Standard Schema
    message: messageSchema,
  },
})
```

Standard Schema integration enables validation with Zod, Valibot, ArkType, and supports custom serialization for BigInts, Dates, etc.

## Design Principles

**Composability**: The protocol is a building block, not a complete solution. Applications combine it with transport layers (durable streams, WebSockets, Server-Sent Events) and storage backends (TanStack DB, IndexedDB, SQLite) as needed.

**Type Safety**: TypeScript-first with discriminated unions and type guards. Multi-type streams use the `type` field to route events to the correct handlers.

**Decoupled Materialization**: Unlike Electric SQL v1 which bundles sync and storage, we separate event processing from persistence. This allows:

- Using MaterializedState standalone for simple cases
- Persisting to databases for complex queries
- Integrating with different storage backends

**Standard Schema**: Following Electric SQL v2's direction, we use Standard Schema for validation rather than coupling to specific schema libraries.

## Relationship to Electric SQL

Inspired by Electric SQL's shape subscription model but diverging in key ways:

| Aspect          | Electric 1.x           | This Package              |
| --------------- | ---------------------- | ------------------------- |
| Source          | PostgreSQL tables      | Any JSON events           |
| Keys            | Composite PKs          | Simple strings            |
| Types           | Single table per shape | Multiple types per stream |
| Coupling        | Bundled with Postgres  | Transport-agnostic        |
| Materialization | Built-in client        | Decoupled from transport  |

Aligns with Electric 2.0's philosophy: "each piece can be used independently or composed together."

## Use Case Examples

### 1. Key/Value Store

Simple synced configuration with optimistic updates:

```typescript
// Define state
const state = defineStreamState({
  collections: {
    config: { schema: configSchema, type: "config" },
  },
})

const db = await createStreamDB({ stream, state })

// Set values
await stream.append({
  type: "config",
  key: "theme",
  value: "dark",
  headers: { operation: "insert" },
})

await stream.append({
  type: "config",
  key: "language",
  value: "en",
  headers: { operation: "insert" },
})

// Query
await db.preload()
const theme = await db.config.get("theme") // "dark"
```

### 2. Presence Tracking

Real-time online status with heartbeat semantics:

```typescript
const state = defineStreamState({
  collections: {
    presence: { schema: presenceSchema, type: "presence" },
  },
})

// User comes online
await stream.append({
  type: "presence",
  key: "user:123",
  value: { status: "online", lastSeen: Date.now() },
  headers: { operation: "insert" },
})

// Heartbeat updates
setInterval(async () => {
  await stream.append({
    type: "presence",
    key: "user:123",
    value: { status: "online", lastSeen: Date.now() },
    headers: { operation: "update" },
  })
}, 30000)

// User goes offline (timeout or explicit)
await stream.append({
  type: "presence",
  key: "user:123",
  headers: { operation: "delete" },
})
```

### 3. Chat Rooms

Multi-type stream with users, messages, reactions, and read receipts:

```typescript
const state = defineStreamState({
  collections: {
    users: { schema: userSchema, type: "user" },
    messages: { schema: messageSchema, type: "message" },
    reactions: { schema: reactionSchema, type: "reaction" },
    receipts: { schema: receiptSchema, type: "receipt" },
  },
})

const db = await createStreamDB({ stream, state })

// User joins room
await stream.append({
  type: "user",
  key: "user:123",
  value: { name: "Kyle", joinedAt: Date.now() },
  headers: { operation: "insert" },
})

// Send message
await stream.append({
  type: "message",
  key: "msg:456",
  value: { userId: "user:123", text: "Hello!", timestamp: Date.now() },
  headers: { operation: "insert" },
})

// Add reaction
await stream.append({
  type: "reaction",
  key: "reaction:789",
  value: { messageId: "msg:456", userId: "user:456", emoji: "👍" },
  headers: { operation: "insert" },
})

// Mark as read
await stream.append({
  type: "receipt",
  key: "receipt:user:456:msg:456",
  value: { userId: "user:456", messageId: "msg:456", readAt: Date.now() },
  headers: { operation: "insert" },
})

// Query all types
await db.preload()
const messages = db.messages.getType("message")
const reactions = db.reactions.getType("reaction")
```

### 4. Feature Flags

Real-time configuration with rollout controls:

```typescript
const state = defineStreamState({
  collections: {
    flags: { schema: flagSchema, type: "flag" },
  },
})

// Enable feature for beta users
await stream.append({
  type: "flag",
  key: "new-editor",
  value: {
    enabled: true,
    rollout: { type: "percentage", value: 10 },
    updatedAt: Date.now(),
  },
  headers: { operation: "insert" },
})

// Update rollout percentage
await stream.append({
  type: "flag",
  key: "new-editor",
  value: {
    enabled: true,
    rollout: { type: "percentage", value: 50 },
    updatedAt: Date.now(),
  },
  headers: { operation: "update" },
})

// All clients automatically see the change
await db.preload()
const flag = await db.flags.get("new-editor")
```

### 5. Shopping Cart

Cross-device cart synchronization:

```typescript
const state = defineStreamState({
  collections: {
    cart: { schema: cartItemSchema, type: "cart" },
  },
})

// Add item
await stream.append({
  type: "cart",
  key: "item:123",
  value: { productId: "123", quantity: 2, price: 29.99 },
  headers: { operation: "insert" },
})

// Update quantity
await stream.append({
  type: "cart",
  key: "item:123",
  value: { productId: "123", quantity: 3, price: 29.99 },
  headers: { operation: "update" },
})

// Remove item
await stream.append({
  type: "cart",
  key: "item:123",
  headers: { operation: "delete" },
})

// Cart syncs across all devices
await db.preload()
const items = db.cart.getType("cart")
```

### 6. TanStack DB Integration

Stream-backed collections with automatic sync:

```typescript
const db = await createStreamDB({
  stream: durableStream,
  state: defineStreamState({
    collections: {
      users: { schema: userSchema, type: "user" },
      messages: { schema: messageSchema, type: "message" },
    },
  }),
})

await db.preload()
const user = await db.users.get("123")
```

### 7. Optimistic Mutations

TanStack DB collections can support automatic optimistic updates - local writes are applied immediately to the client state while being sent to the stream:

```typescript
// Write locally - UI updates instantly
await db.messages.insert({
  id: "msg-123",
  text: "Hello!",
  timestamp: Date.now(),
})

// Behind the scenes:
// 1. Apply immediately to local collection (optimistic)
// 2. Send change event to stream
// 3. Broadcast to other clients
// 4. Confirm when change event comes back from stream
```

This provides responsive UIs while maintaining eventual consistency. When the change event returns from the stream, it either confirms the optimistic update or corrects the local state if there were conflicts or server-side modifications.

## Implementation Status

**Completed**:

- ✅ Core types (ChangeMessage, ControlMessage, type guards)
- ✅ MaterializedState class with apply/batch/query methods
- ✅ Integration with durable streams JSON mode
- ✅ Test coverage (12 tests: 7 unit + 5 integration)

**In Progress**:

- 🔨 TanStack DB integration (`createStreamDB`)
- 🔨 Standard Schema validation
- 🔨 Operation builders (insert/update/delete helpers)

**Planned**:

- 📋 Database persistence patterns and examples
- 📋 Move TanStack integration to `@tanstack/durable-streams-db-collection`
- 📋 Documentation for all eight use cases
- 📋 Production hardening and error handling

## References

- Full RFC: `docs/state-package-issue.md`
- Draft PR: #30
- Electric SQL 2.0: https://electric-sql.com/blog/2025/01/08/electric-2-0

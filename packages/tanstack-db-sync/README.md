# @durable-streams/tanstack-db-sync

Sync TanStack DB collection changes to Durable Streams using the State Protocol.

This package subscribes to changes on TanStack DB collections and automatically appends them to a Durable Stream in the State Protocol format, enabling real-time synchronization between local TanStack DB collections and remote durable streams.

## Installation

```bash
npm install @durable-streams/tanstack-db-sync @tanstack/db @durable-streams/client
```

## Usage

### Sync a Single Collection

```typescript
import { syncCollectionToStream } from "@durable-streams/tanstack-db-sync"
import { createCollection } from "@tanstack/db"
import { DurableStream } from "@durable-streams/client"

// Create your TanStack DB collection
const usersCollection = createCollection({
  id: "users",
  getKey: (user) => user.id,
  schema: userSchema,
})

// Create your durable stream
const stream = await DurableStream.create({
  url: "https://api.example.com/streams/users",
  contentType: "application/json",
})

// Start syncing changes to the stream
const subscription = syncCollectionToStream({
  collection: usersCollection,
  stream,
  entityType: "user", // The `type` field in State Protocol events
  primaryKeyField: "id", // Excluded from value to avoid duplication
})

// Make changes to the collection - they're automatically synced
usersCollection.insert({
  id: "user-1",
  name: "Alice",
  email: "alice@example.com",
})
usersCollection.update("user-1", (draft) => {
  draft.name = "Alice Smith"
})
usersCollection.delete("user-1")

// When done, unsubscribe
subscription.unsubscribe()
```

### Sync Multiple Collections

```typescript
import { syncCollectionsToStream } from "@durable-streams/tanstack-db-sync"

const subscription = syncCollectionsToStream({
  collections: {
    users: {
      collection: usersCollection,
      entityType: "user",
      primaryKeyField: "id",
    },
    messages: {
      collection: messagesCollection,
      entityType: "message",
      primaryKeyField: "id",
    },
  },
  stream,
  includeInitialState: true, // Include existing data as insert events
})
```

### Manual Conversion

If you need more control, you can convert changes manually:

```typescript
import {
  changeToStateEvent,
  changesToStateEvents,
} from "@durable-streams/tanstack-db-sync"

// Convert a single change
collection.subscribeChanges(async (changes) => {
  for (const change of changes) {
    const event = changeToStateEvent(change, "user", {
      primaryKeyField: "id",
      transformHeaders: (change) => ({
        timestamp: new Date().toISOString(),
      }),
    })
    await stream.append(event)
  }
})

// Or convert an array of changes
const events = changesToStateEvents(changes, "user", { primaryKeyField: "id" })
```

## API Reference

### `syncCollectionToStream(options)`

Syncs a TanStack DB collection to a Durable Stream.

**Options:**

- `collection` - The TanStack DB collection to subscribe to
- `stream` - The DurableStream to append changes to
- `entityType` - The entity type discriminator (appears as `type` in events)
- `primaryKeyField` (optional) - Key field to exclude from values
- `includeInitialState` (optional) - Include current state as initial inserts
- `transformHeaders` (optional) - Function to add custom headers
- `transformValue` (optional) - Function to transform values

**Returns:** `{ unsubscribe: () => void }`

### `syncCollectionsToStream(options)`

Syncs multiple TanStack DB collections to a single Durable Stream.

**Options:**

- `collections` - Map of collection definitions
- `stream` - The DurableStream to append changes to
- `includeInitialState` (optional) - Include current state as initial inserts

**Returns:** `{ unsubscribe: () => void }`

### `changeToStateEvent(change, entityType, options?)`

Converts a single TanStack DB ChangeMessage to a State Protocol ChangeEvent.

### `changesToStateEvents(changes, entityType, options?)`

Converts an array of TanStack DB changes to State Protocol events.

## State Protocol Format

Changes are converted to the State Protocol format:

```typescript
// TanStack DB ChangeMessage
{
  key: "user-1",
  value: { id: "user-1", name: "Alice" },
  previousValue: { id: "user-1", name: "Alice Old" },
  type: "update",
  metadata: { txid: "abc-123" }
}

// State Protocol ChangeEvent
{
  type: "user",           // entityType from options
  key: "user-1",
  value: { name: "Alice" },        // primaryKeyField excluded
  old_value: { name: "Alice Old" },
  headers: {
    operation: "update",
    txid: "abc-123"       // metadata merged into headers
  }
}
```

## License

Apache-2.0

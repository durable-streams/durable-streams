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

## Examples

### Electric SQL: Join Two Tables and Sync the Result

This example shows how to sync two Electric SQL tables (users and posts), join them with a live query, and sync the joined results to a durable stream.

```typescript
import { createCollection, createQuery } from "@tanstack/db"
import { electricSync } from "@tanstack/db-electric"
import { syncCollectionToStream } from "@durable-streams/tanstack-db-sync"
import { DurableStream } from "@durable-streams/client"

// Create Electric-synced collections for two tables
const usersCollection = createCollection({
  id: "users",
  getKey: (user) => user.id,
  sync: electricSync({
    url: "http://localhost:3000/v1/shape",
    table: "users",
  }),
})

const postsCollection = createCollection({
  id: "posts",
  getKey: (post) => post.id,
  sync: electricSync({
    url: "http://localhost:3000/v1/shape",
    table: "posts",
  }),
})

// Create a live query that joins users and posts
const postsWithAuthors = createQuery({
  id: "posts-with-authors",
  getKey: (item) => item.postId,
  query: () => ({
    from: postsCollection,
    join: {
      author: {
        from: usersCollection,
        on: (post) => post.authorId,
      },
    },
    select: (post, { author }) => ({
      postId: post.id,
      title: post.title,
      content: post.content,
      authorName: author?.name ?? "Unknown",
      authorEmail: author?.email,
    }),
  }),
})

// Create the output stream
const stream = await DurableStream.create({
  url: "https://api.example.com/streams/posts-feed",
  contentType: "application/json",
})

// Sync the joined query results to the stream
// Whenever a user or post changes, the join is recomputed
// and the changes are synced to the stream
const subscription = syncCollectionToStream({
  collection: postsWithAuthors,
  stream,
  entityType: "post-with-author",
  primaryKeyField: "postId",
})

// The stream now receives events like:
// {
//   type: "post-with-author",
//   key: "post-123",
//   value: {
//     title: "Hello World",
//     content: "...",
//     authorName: "Alice",
//     authorEmail: "alice@example.com"
//   },
//   headers: { operation: "insert" }
// }
```

### API Polling: Sync External API Data

This example shows how to poll an external API every 3 seconds and sync changes to a durable stream.

```typescript
import { createCollection } from "@tanstack/db"
import { syncCollectionToStream } from "@durable-streams/tanstack-db-sync"
import { DurableStream } from "@durable-streams/client"

interface StockQuote {
  symbol: string
  price: number
  change: number
  volume: number
  timestamp: string
}

// Create a collection with a polling sync
const stocksCollection = createCollection<StockQuote, string>({
  id: "stocks",
  getKey: (stock) => stock.symbol,
  sync: {
    sync: ({ begin, write, commit, markReady }) => {
      let isReady = false

      const poll = async () => {
        try {
          const response = await fetch("https://api.example.com/stocks/quotes")
          const quotes: StockQuote[] = await response.json()

          begin()
          for (const quote of quotes) {
            write({
              type: "insert", // Use insert - collection handles upsert logic
              value: quote,
            })
          }
          commit()

          if (!isReady) {
            markReady()
            isReady = true
          }
        } catch (error) {
          console.error("Failed to fetch stock quotes:", error)
        }
      }

      // Initial poll
      poll()

      // Poll every 3 seconds
      const intervalId = setInterval(poll, 3000)

      // Return cleanup function
      return () => {
        clearInterval(intervalId)
      }
    },
  },
})

// Create the output stream
const stream = await DurableStream.create({
  url: "https://api.example.com/streams/stock-updates",
  contentType: "application/json",
})

// Sync stock changes to the stream
// Only actual changes are synced (TanStack DB tracks diffs)
const subscription = syncCollectionToStream({
  collection: stocksCollection,
  stream,
  entityType: "stock",
  primaryKeyField: "symbol",
  transformHeaders: () => ({
    timestamp: new Date().toISOString(),
  }),
})

// The stream receives events only when prices actually change:
// {
//   type: "stock",
//   key: "AAPL",
//   value: {
//     price: 178.52,
//     change: 2.34,
//     volume: 52340000,
//     timestamp: "2024-01-15T14:30:00Z"
//   },
//   headers: {
//     operation: "update",
//     timestamp: "2024-01-15T14:30:01.234Z"
//   }
// }

// Cleanup when done
subscription.unsubscribe()
```

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

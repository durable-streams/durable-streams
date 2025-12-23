# Wikipedia EventStreams Example

A real-time dashboard showing Wikipedia edits from around the world, demonstrating the integration of:

- Server-side SSE consumption (Wikipedia EventStreams API)
- Durable Streams for event persistence
- Solid.js for reactive UI
- @tanstack/solid-db for live queries

## Architecture

```
Wikipedia SSE API → Worker → Durable Stream → StreamDB → Solid.js UI
```

**Three processes work together:**

1. **DurableStream Server** (`@durable-streams/server`)
   - Provides the HTTP API for durable streams
   - Runs on http://localhost:4437

2. **Wikipedia Worker** (`../wikipedia-worker`)
   - Connects to Wikipedia's SSE endpoint
   - Transforms events to state protocol format
   - Writes to `/wikipedia-events` stream

3. **Solid.js Client** (this package)
   - Reads from stream via StreamDB
   - Provides faceted filtering and stats
   - Updates UI reactively as events arrive

## Setup

### 1. Build Dependencies

From the monorepo root:

```bash
pnpm install
pnpm build
```

### 2. Start DurableStream Server

```bash
pnpm --filter @durable-streams/server dev
```

Server runs on http://localhost:4437

### 3. Start Wikipedia Worker

```bash
cd ../wikipedia-worker
pnpm dev
```

The worker will:

- Connect to https://stream.wikimedia.org/v2/stream/recentchange
- Transform events to the state protocol format
- Write them to `/wikipedia-events` stream
- Log statistics every 60 seconds

### 4. Start the Solid.js Client

```bash
cd examples/state/wikipedia-events
pnpm install
pnpm dev
```

App opens at http://localhost:5174

## Features

### Faceted Filtering

- **Language**: Filter by Wikipedia language edition (en, es, fr, ja, etc.)
- **Event Type**: Show only specific types (edit, new page, log, categorize)
- **Contributors**: Toggle bot edits on/off
- **Namespace**: Filter by namespace (Article, Talk, User, File, etc.)

### Real-time Statistics

Computed from the last 100 events:

- **Events/sec**: Rolling average throughput
- **Total Events**: Cumulative count
- **Top Languages**: Most active Wikipedia editions
- **Event Types**: Breakdown by type
- **Bot Activity**: Percentage of bot edits
- **Active Users**: Most frequent human contributors

### Event Display

Each event shows:

- Language badge (e.g., "en", "fr", "ja")
- Event type badge (edit, new, log, categorize)
- Bot indicator (🤖) if automated
- Page title with clickable link to Wikipedia
- Username and timestamp
- Byte change (+/- indicators)
- Edit summary comment

## Implementation Highlights

### StreamDB Integration

```typescript
const db = createStreamDB({
  streamOptions: {
    url: "http://localhost:4437/v1/stream/wikipedia-events",
    contentType: "application/json",
  },
  state: stateSchema,
})

await db.preload()

// Subscribe to changes
db.collections.events.subscribeChanges(() => {
  // Re-render on new events
})
```

### Solid.js Reactivity

```typescript
const filteredEvents = createMemo(() => {
  return events()
    .filter(event => /* apply filters */)
    .sort((a, b) => /* sort by timestamp */)
    .slice(0, 100);
});
```

Fine-grained reactivity means only affected components re-render when filters change.

### State Protocol Events

Worker transforms Wikipedia events to state protocol format:

```typescript
stateSchema.events.insert({
  value: {
    id: `${serverName}-${timestamp}-${id}`,
    type: "edit",
    timestamp: "2025-12-16T18:00:00.000Z",
    user: "ExampleUser",
    isBot: false,
    namespace: 0,
    title: "Wikipedia",
    serverName: "en.wikipedia.org",
    language: "en",
    lengthOld: 1000,
    lengthNew: 1050,
    revisionId: 12345,
    revisionOldId: 12344,
    comment: "Fixed typo",
    eventUrl: "https://en.wikipedia.org/wiki/Wikipedia?diff=12345&oldid=12344",
  },
})
```

## Troubleshooting

**No events appearing:**

- Check that the Wikipedia worker is running and connected
- Verify DurableStream server is running on port 4437
- Check browser console for connection errors

**"Connection Failed" error:**

- Ensure all three processes are running (server, worker, client)
- Check that the stream exists: `curl http://localhost:4437/v1/stream/wikipedia-events`
- Verify network connectivity to Wikipedia (worker may have failed)

**Slow performance:**

- The UI displays only the latest 100 events
- If you see thousands of events, consider clearing the stream and restarting
- Check browser DevTools Performance tab

## Data Source

This example uses the [Wikimedia EventStreams API](https://wikitech.wikimedia.org/wiki/Event_Platform/EventStreams):

- **Endpoint**: https://stream.wikimedia.org/v2/stream/recentchange
- **Format**: Server-Sent Events (SSE)
- **Rate**: ~10-50 events per second
- **Coverage**: All Wikimedia projects (Wikipedia, Wiktionary, Wikidata, Commons, etc.)
- **Languages**: 300+ language editions

The data stream is public and requires no authentication.

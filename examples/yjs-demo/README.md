# Yjs Collaborative Editor Demo

A real-time collaborative text editor built with Yjs, CodeMirror, and the Durable Streams Yjs provider. Multiple users can edit the same document simultaneously with live cursors and presence.

## Features

- **Real-time Collaboration**: Multiple users can edit the same document
- **Live Presence**: See who else is editing with colored cursors and names
- **Automatic Sync**: Documents sync automatically via HTTP long-polling
- **Server-side Compaction**: Documents are automatically compacted for fast initial loads
- **Room-based**: Create and join named rooms

## Quick Start

You need to run two servers: a Durable Streams server (storage backend) and a Yjs server (protocol layer).

### 1. Start the Durable Streams Server

In one terminal:

```bash
cd packages/cli
pnpm start:dev
```

This starts the DS server at `http://localhost:4437`.

### 2. Start the Yjs Server

In another terminal, create a simple server script or run the Yjs server programmatically:

```typescript
// yjs-server.ts
import { DurableStreamTestServer } from "@durable-streams/server"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

// Start DS server
const dsServer = new DurableStreamTestServer({ port: 4437 })
await dsServer.start()

// Start Yjs server (wraps DS server)
const yjsServer = new YjsServer({
  port: 4438,
  dsServerUrl: dsServer.url,
  compactionThreshold: 1024 * 1024, // 1MB
  minUpdatesBeforeCompaction: 100,
})

await yjsServer.start()
console.log(`Yjs server running at ${yjsServer.url}`)
```

Or use the combined approach with a single server setup (see below).

### 3. Run the Demo

```bash
cd examples/yjs-demo
pnpm dev
```

Open `http://localhost:5173` in your browser.

## Configuration

The demo connects to the server based on `VITE_SERVER_URL` environment variable, or falls back to `http://localhost:4437`.

Create a `.env` file in the yjs-demo directory:

```env
VITE_SERVER_URL=http://localhost:4437
```

**Note**: The demo constructs the Yjs URL as `${VITE_SERVER_URL}/v1/yjs/rooms`, so your Yjs server should be accessible at that path.

## Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Browser       │      │   Yjs Server    │      │   DS Server     │
│   (React App)   │◄────►│   (Port 4438)   │◄────►│   (Port 4437)   │
│                 │ HTTP │                 │ HTTP │                 │
│   - CodeMirror  │      │   - Compaction  │      │   - Storage     │
│   - Yjs         │      │   - Snapshots   │      │   - Streams     │
│   - Awareness   │      │   - Protocol    │      │                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

### Components

- **YjsProvider** (`@durable-streams/y-durable-streams`): Client-side Yjs provider that syncs documents over HTTP
- **YjsServer** (`@durable-streams/y-durable-streams/server`): Server implementing the Yjs Durable Streams Protocol
- **DurableStreamTestServer** (`@durable-streams/server`): Storage backend for durable streams

## Room System

- Rooms are identified by URL path (e.g., `/room/my-document`)
- Room registry is stored in a separate durable stream
- Each room has its own Yjs document

## Presence

The demo uses Yjs awareness for presence:

- Each user gets a random name and color
- Cursor positions are shared in real-time
- Users can edit their display name
- Inactive users are automatically removed after timeout

## Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm dev

# Type check
pnpm typecheck

# Build for production
pnpm build
```

## Troubleshooting

### "Error connecting to room"

1. Make sure both servers are running (DS server on 4437, Yjs server on 4438)
2. Check that `VITE_SERVER_URL` points to the correct server
3. Check browser console for CORS errors

### No live updates

1. Verify the Yjs server is running and accessible
2. Check network tab for failed requests
3. Look for connection errors in browser console

### Presence not showing

1. Awareness requires SSE support - check server logs
2. Multiple browser windows should show each other's cursors
3. Presence times out after ~35 seconds of inactivity

## License

Apache-2.0

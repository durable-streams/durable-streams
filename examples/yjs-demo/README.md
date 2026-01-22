# Yjs Collaborative Editor Demo

A real-time collaborative text editor built with Yjs, CodeMirror, and the Durable Streams Yjs provider. Multiple users can edit the same document simultaneously with live cursors and presence.

## Features

- **Real-time Collaboration**: Multiple users can edit the same document
- **Live Presence**: See who else is editing with colored cursors and names
- **Automatic Sync**: Documents sync automatically via HTTP long-polling
- **Server-side Compaction**: Documents are automatically compacted for fast initial loads
- **Room-based**: Create and join named rooms

## Quick Start

### 1. Start the Servers

In one terminal, start both the DS server (storage) and Yjs server (protocol):

```bash
cd examples/yjs-demo
pnpm dev:server
```

This starts:

- DS server at `http://localhost:4437`
- Yjs server at `http://localhost:4438`

### 2. Run the Demo

In another terminal:

```bash
cd examples/yjs-demo
pnpm dev
```

Open `http://localhost:5173` in your browser.

## Configuration

The demo connects to the Yjs server based on `VITE_SERVER_URL` environment variable, or falls back to `http://localhost:4438`.

Create a `.env` file in the yjs-demo directory to customize:

```env
VITE_SERVER_URL=http://localhost:4438
```

**Note**: The demo constructs the Yjs URL as `${VITE_SERVER_URL}/v1/yjs/rooms`.

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

# Start the backend servers (DS + Yjs)
pnpm dev:server

# In another terminal, run the frontend
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

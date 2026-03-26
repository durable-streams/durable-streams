# Yjs collaborative editor demo

A real-time collaborative text editor built with Yjs, CodeMirror, and the Durable Streams Yjs provider. Multiple users can edit the same document simultaneously with live cursors and presence.

## Features

- **Real-time collaboration**: Multiple users can edit the same document
- **Live presence**: See who else is editing with colored cursors and names
- **Automatic sync**: Documents sync automatically via HTTP long-polling
- **Server-side compaction**: Documents are automatically compacted for fast initial loads
- **Room-based**: Create and join named rooms

## Quick start

### Prerequisites

Build the Caddy binary with the Durable Streams plugin:

```bash
cd packages/caddy-plugin
go build -o durable-streams-server ./cmd/caddy
```

### 1. Start the servers

In one terminal, start the Caddy HTTPS proxy and Yjs server:

```bash
cd examples/yjs-demo
pnpm dev:server
```

This starts:

- **Caddy** as an HTTPS reverse proxy at `https://localhost:4443` (HTTP/2), with the Durable Streams plugin handling `/v1/stream/*`
- **Yjs server** (Node.js) on internal port `4438`, reverse-proxied by Caddy at `/v1/yjs/*`

All traffic goes through the single Caddy origin at `https://localhost:4443`.

### 2. Run the demo

In another terminal:

```bash
cd examples/yjs-demo
pnpm dev
```

Open `http://localhost:5173` in your browser.

> **Note**: On first visit, your browser will warn about Caddy's self-signed TLS certificate. You need to accept/trust the certificate for `https://localhost:4443` before the demo can connect. Visit `https://localhost:4443` directly and accept the certificate, then reload the demo.

## Configuration

Both the Yjs server and Durable Streams endpoints default to the current origin (or `https://localhost:4443` for local development). You can override them with environment variables.

Create a `.env` file in the yjs-demo directory to customize:

```env
# Yjs document server
VITE_YJS_URL=https://localhost:4443/v1/yjs
VITE_YJS_TOKEN=your-yjs-bearer-token

# Room registry (Durable Streams)
VITE_DS_URL=https://localhost:4443/v1/stream
VITE_DS_TOKEN=your-ds-bearer-token
```

| Variable         | Default              | Description                                                  |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| `VITE_YJS_URL`   | `<origin>/v1/yjs`    | Base URL for the Yjs document server                         |
| `VITE_YJS_TOKEN` | —                    | Bearer token for authenticating with the Yjs server          |
| `VITE_DS_URL`    | `<origin>/v1/stream` | Base URL for Durable Streams (used for the room registry)    |
| `VITE_DS_TOKEN`  | —                    | Bearer token for authenticating with the Durable Streams API |

`VITE_SERVER_URL` is also supported as a fallback for `VITE_YJS_URL`.

## Architecture

```
                         https://localhost:4443 (HTTP/2)
                        ┌────────────────────────────────┐
                        │          Caddy Server           │
┌─────────────────┐     │                                │
│   Browser        │     │  /v1/stream/*                  │
│   (React App)    │────►│    → Durable Streams plugin    │
│                  │HTTPS│      (built-in storage)        │
│   - CodeMirror   │     │                                │
│   - Yjs          │     │  /v1/yjs/*                     │
│   - Awareness    │     │    → reverse_proxy to Node.js  │
└─────────────────┘     │      (port 4438, internal)     │
                        │                                │
                        └────────────┬───────────────────┘
                                     │ HTTP
                              ┌──────▼──────────┐
                              │   Yjs Server     │
                              │   (Node.js)      │
                              │   Port 4438      │
                              │                  │
                              │   - Compaction   │
                              │   - Snapshots    │
                              │   - Protocol     │
                              └─────────────────┘
```

### Components

- **YjsProvider** (`@durable-streams/y-durable-streams`): Client-side Yjs provider that syncs documents over HTTP
- **YjsServer** (`@durable-streams/y-durable-streams/server`): Node.js server implementing the Yjs Durable Streams Protocol
- **Caddy with Durable Streams plugin** (`packages/caddy-plugin`): HTTPS reverse proxy with built-in Durable Streams storage — replaces the old Node.js `DurableStreamTestServer`
- **Caddyfile** (`examples/yjs-demo/Caddyfile`): Routing configuration for the Caddy server

### How routing works

The `Caddyfile` configures Caddy to serve everything on `https://localhost:4443`:

- `/v1/stream/*` is handled directly by Caddy's built-in `durable_streams` plugin (storage and streaming)
- `/v1/yjs/*` is reverse-proxied to the Node.js Yjs server running on `127.0.0.1:4438`

This single-origin setup enables HTTP/2 multiplexing for all requests.

## Room system

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

# Build the Caddy binary (one-time, from repo root)
cd packages/caddy-plugin && go build -o durable-streams-server ./cmd/caddy

# Start the backend servers (Caddy + Yjs)
cd examples/yjs-demo && pnpm dev:server

# In another terminal, run the frontend
pnpm dev

# Type check
pnpm typecheck

# Build for production
pnpm build
```

## Troubleshooting

### Browser shows certificate warning

Caddy generates a self-signed TLS certificate for `localhost`. On first visit you must accept the certificate:

1. Navigate to `https://localhost:4443` in your browser
2. Accept / trust the self-signed certificate
3. Reload the demo at `http://localhost:5173`

### "Error connecting to room"

1. Make sure the servers are running (`pnpm dev:server` — Caddy on 4443, Yjs on 4438)
2. Make sure you have accepted the self-signed certificate (see above)
3. Check that `VITE_SERVER_URL` and `VITE_DS_URL` point to `https://localhost:4443`
4. Check browser console for connection errors

### Caddy fails to start

1. Ensure the Caddy binary has been built: `cd packages/caddy-plugin && go build -o durable-streams-server ./cmd/caddy`
2. Check that port 4443 is not already in use
3. Review Caddy error output in the terminal

### No live updates

1. Verify the servers are running and accessible at `https://localhost:4443`
2. Check network tab for failed requests
3. Look for connection errors in browser console

### Presence not showing

1. Awareness requires SSE support — check server logs
2. Multiple browser windows should show each other's cursors
3. Presence times out after ~35 seconds of inactivity

## License

Apache-2.0

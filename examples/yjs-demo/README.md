# Yjs collaborative editor demo

A real-time collaborative text editor using Yjs, CodeMirror, and Durable Streams. Open the same room in multiple browser windows to see live cursors and presence.

## Quick start

### Prerequisites

- [Go](https://go.dev/) (to build the Caddy server)
- [pnpm](https://pnpm.io/)

### 1. Build the Caddy server (one-time)

From the repo root:

```bash
cd packages/caddy-plugin
go build -o durable-streams-server ./cmd/caddy
```

### 2. Start the servers

```bash
cd examples/yjs-demo
pnpm install
pnpm dev:server
```

This starts Caddy (HTTPS on `https://localhost:4443`) and a Yjs server (internal, port 4438). All traffic routes through Caddy.

### 3. Start the frontend

In a second terminal:

```bash
cd examples/yjs-demo
pnpm dev
```

### 4. Open the demo

Go to `http://localhost:5173`. Your browser will warn about Caddy's self-signed certificate — visit `https://localhost:4443` first to accept it, then reload the demo.

Create a room, then open the same URL in another window to collaborate.

## Environment variables

No configuration is needed for local development. When pointing at a remote server, create a `.env` file:

```env
# Yjs document server
VITE_YJS_URL=https://your-server.com/v1/yjs
VITE_YJS_TOKEN=your-bearer-token

# Room registry (Durable Streams)
VITE_DS_URL=https://your-server.com/v1/stream
VITE_DS_TOKEN=your-bearer-token
```

| Variable         | Default              | Description                                      |
| ---------------- | -------------------- | ------------------------------------------------ |
| `VITE_YJS_URL`   | `<origin>/v1/yjs`    | Yjs document server URL                          |
| `VITE_YJS_TOKEN` | —                    | Bearer token for the Yjs server                  |
| `VITE_DS_URL`    | `<origin>/v1/stream` | Durable Streams URL (used for the room registry) |
| `VITE_DS_TOKEN`  | —                    | Bearer token for Durable Streams                 |

`VITE_SERVER_URL` is also accepted as a fallback for `VITE_YJS_URL`.

## How it works

The demo has two server-side components behind a single Caddy origin:

- **`/v1/stream/*`** — Caddy's built-in Durable Streams plugin stores the room registry (a JSON stream tracking which rooms exist).
- **`/v1/yjs/*`** — A Node.js Yjs server that manages document sync, snapshots, and compaction. It stores Yjs updates in durable streams via Caddy.

On the client side:

- **YjsProvider** connects to a room's document, discovers the latest snapshot, applies it, then streams live updates over SSE.
- **Awareness** runs on a separate SSE stream to broadcast cursor positions and user presence.
- **Room registry** uses StreamDB (backed by Durable State) to track rooms with reactive queries.

## Troubleshooting

**Certificate warning** — Caddy auto-generates a self-signed cert. Visit `https://localhost:4443` and accept it before using the demo.

**"Error connecting to room"** — Check that both servers are running (`pnpm dev:server`) and you've accepted the certificate.

**Caddy fails to start** — Make sure you've built the binary (`cd packages/caddy-plugin && go build -o durable-streams-server ./cmd/caddy`) and port 4443 is free.

# Yjs collaborative editor demo

A real-time collaborative text editor using y-durable-streams and CodeMirror. Open the same room in multiple browser windows to see live cursors and presence.

## Quick start

### 1. Start the servers

This requires the `durable-streams-server` binary — see the [deployment guide](https://durablestreams.com/deployment) for install options.

```bash
cd examples/yjs-demo
pnpm install
pnpm dev:server
```

This starts the TypeScript Durable Streams reference server (`http://localhost:4437`) and the y-durable-streams server (`http://localhost:4438`). This is a development setup over plain HTTP/1.1 on two origins; a deployment should sit behind a TLS-terminating edge that speaks HTTP/2 to browsers, so that the open SSE connections of several documents multiplex on one connection instead of counting against the browser's per-origin limit. Start the UI with `VITE_DS_URL=http://localhost:4437/v1/stream VITE_YJS_URL=http://localhost:4438/v1/yjs pnpm dev`.

### 2. Start the frontend

In a second terminal:

```bash
cd examples/yjs-demo
pnpm dev
```

### 3. Open the demo

Go to `http://localhost:5173`.

Create a room, then open the same URL in another window to collaborate.

## Environment variables

No configuration is needed for local development. When pointing at a remote server, create a `.env` file:

```env
# y-durable-streams server
VITE_YJS_URL=https://your-server.com/v1/yjs
VITE_YJS_TOKEN=your-bearer-token

# Room registry (Durable Streams)
VITE_DS_URL=https://your-server.com/v1/stream
VITE_DS_TOKEN=your-bearer-token
```

| Variable         | Default              | Description                                      |
| ---------------- | -------------------- | ------------------------------------------------ |
| `VITE_YJS_URL`   | `<origin>/v1/yjs`    | y-durable-streams server URL                     |
| `VITE_YJS_TOKEN` | —                    | Bearer token for y-durable-streams               |
| `VITE_DS_URL`    | `<origin>/v1/stream` | Durable Streams URL (used for the room registry) |
| `VITE_DS_TOKEN`  | —                    | Bearer token for Durable Streams                 |

`VITE_SERVER_URL` is also accepted as a fallback for `VITE_YJS_URL`.

## How it works

The demo has two server-side components:

- **`/v1/stream/*`** — The Durable Streams server stores the room registry (a JSON stream tracking which rooms exist).
- **`/v1/yjs/*`** — The y-durable-streams server manages document sync, snapshots, and compaction. It stores Yjs updates in durable streams.

On the client side:

- **y-durable-streams client** connects to a room's document, discovers the latest snapshot, applies it, then streams live updates over SSE.
- **Awareness** runs on a separate SSE stream to broadcast cursor positions and user presence.
- **Room registry** uses StreamDB (backed by Durable State) to track rooms with reactive queries.

## Troubleshooting

**"Error connecting to room"** — Check that both servers are running (`pnpm dev:server`) and you've accepted the certificate.

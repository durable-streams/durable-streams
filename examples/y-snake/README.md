# Multiplayer Snake demo

A real-time multiplayer Snake game using y-durable-streams for game state synchronization and StreamDB for room registry and high scores. Create a room, share the link, and compete with friends.

## Quick start

### 1. Start the servers

This requires the `durable-streams-server` binary — see the [deployment guide](https://durablestreams.com/deployment) for install options.

```bash
cd examples/y-snake
pnpm install
pnpm dev:server
```

This starts Caddy (HTTPS on `https://localhost:4444`) and the y-durable-streams server (internal, port 4439). All traffic routes through Caddy.

### 2. Start the frontend

In a second terminal:

```bash
cd examples/y-snake
pnpm dev
```

### 3. Open the demo

Go to `http://localhost:3002`. Your browser will warn about Caddy's self-signed certificate — visit `https://localhost:4444` first to accept it, then reload the demo.

Create a room, then open the same URL in another window to play together.

## Environment variables

No configuration is needed for local development. When pointing at a remote server, create a `.env` file:

```env
# y-durable-streams server
VITE_YJS_URL=https://your-server.com/v1/yjs/snake
VITE_YJS_TOKEN=your-bearer-token

# Room registry and high scores (Durable Streams)
VITE_DS_URL=https://your-server.com/v1/stream
VITE_DS_TOKEN=your-bearer-token
```

| Variable         | Default                 | Description                                                  |
| ---------------- | ----------------------- | ------------------------------------------------------------ |
| `VITE_YJS_URL`   | `<origin>/v1/yjs/snake` | y-durable-streams server URL                                 |
| `VITE_YJS_TOKEN` | —                       | Bearer token for y-durable-streams                           |
| `VITE_DS_URL`    | `<origin>/v1/stream`    | Durable Streams URL (used for room registry and high scores) |
| `VITE_DS_TOKEN`  | —                       | Bearer token for Durable Streams                             |

## How it works

The demo has two server-side components behind a single Caddy origin:

- **`/v1/stream/*`** — Caddy's built-in Durable Streams plugin stores the room registry and per-room high scores as JSON streams.
- **`/v1/yjs/*`** — The y-durable-streams server manages game state synchronization and awareness. It stores Yjs updates in durable streams via Caddy.

On the client side:

- **y-durable-streams client** connects to a room's Yjs document, syncing shared game state (food, obstacles) and per-player state (snake positions, scores) in real time over SSE.
- **Awareness** runs on a separate SSE stream to broadcast player presence. When a player's awareness times out, their snake is removed from the board.
- **Room registry** uses StreamDB (backed by Durable State) to list active rooms with reactive queries. Rooms are created with a 10-minute TTL — the underlying stream expires automatically, no manual cleanup needed.
- **High scores** use a second StreamDB instance per room, keyed by player name. Live scores appear on the leaderboard immediately when they beat existing records and are persisted on death.

## Troubleshooting

**Certificate warning** — Caddy auto-generates a self-signed cert. Visit `https://localhost:4444` and accept it before using the demo.

**"Connection error"** — Check that both servers are running (`pnpm dev:server`) and you've accepted the certificate.

**Caddy fails to start** — Make sure `durable-streams-server` is installed (see [deployment guide](https://durablestreams.com/deployment)) and port 4444 is free.

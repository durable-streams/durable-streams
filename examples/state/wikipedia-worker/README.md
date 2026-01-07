# Wikipedia EventStreams Worker

Background worker that consumes Wikipedia's recent changes SSE stream and writes events to a durable stream.

## Setup

```bash
pnpm install
pnpm dev
```

## Environment Variables

- `DURABLE_STREAMS_URL`: Server URL (default: http://localhost:4437)
- `STREAM_PATH`: Stream path (default: /wikipedia-events)

## Architecture

1. Connects to https://stream.wikimedia.org/v2/stream/recentchange
2. Transforms events to state protocol format
3. Writes to durable stream with insert operations
4. Handles reconnection and errors gracefully

## Running

The worker needs the DurableStream server to be running first:

```bash
# Terminal 1: Start DurableStream server (from monorepo root)
pnpm --filter @durable-streams/server dev

# Terminal 2: Start Wikipedia worker
cd examples/state/wikipedia-worker
pnpm dev
```

The worker will:

- Connect to Wikipedia's EventStreams API
- Transform events to the state protocol format
- Write them to `/wikipedia-events` stream
- Automatically reconnect on connection failures

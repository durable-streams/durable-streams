# Durable Streams Test UI

A web-based testing interface for the Durable Streams protocol. This application provides a simple UI to create, delete, read from, and write to durable streams running on localhost:8787.

## Features

- **Stream Management**: Create and delete streams with different content types
- **Live Reading**: Automatically follow streams in real-time with the `follow()` API
- **Writing**: Write messages to streams with a simple textarea input
- **Stream Registry**: Automatic discovery of all streams via the `__registry__` system stream
- **Dark Theme**: Clean, modern interface optimized for development

## Quick Start

1. **Start the development server** (in a separate terminal):

   ```bash
   cd packages/cli
   pnpm start:dev
   ```

2. **Run the test UI**:

   ```bash
   cd packages/test-ui
   pnpm dev
   ```

3. **Open your browser** to `http://localhost:3000`

## How It Works

### Stream Registry

The UI automatically tracks all streams via a special `__registry__` stream. When you start the development server with the registry hooks enabled, all stream lifecycle events (creates and deletes) are recorded to `/v1/stream/__registry__`.

The registry stream contains newline-delimited JSON events:

```json
{"type":"created","path":"/v1/stream/my-stream","contentType":"text/plain","timestamp":1234567890}
{"type":"deleted","path":"/v1/stream/my-stream","timestamp":1234567891}
```

This means:

- **Streams created by the CLI** are visible in the UI
- **Streams created by the UI** are recorded in the registry
- **Page refreshes** restore the full stream list
- **Multiple clients** can all see the same streams

### Real-Time Following

The UI uses the `stream.follow()` API which automatically:

1. Catches up on any missed messages (from offset `-1`, the beginning)
2. Switches to live mode (SSE or long-polling based on content-type)
3. Handles reconnection and backoff automatically

### Components

- **Left Sidebar**: Lists all streams with their content types
- **Main Panel**: Shows messages from the selected stream
- **Write Section**: Input box to append new messages

## Development

The test UI is built with:

- **Vite** - Fast development and build tool
- **React** - UI library
- **TanStack Router** - Type-safe routing
- **@durable-streams/writer** - Read/write client library

### Project Structure

```
packages/test-ui/
├── src/
│   ├── routes/
│   │   ├── __root.tsx      # Root layout with router devtools
│   │   └── index.tsx        # Main stream testing interface
│   ├── styles.css           # Dark theme styles
│   ├── main.tsx             # App entry point
│   └── routeTree.gen.ts     # Generated route tree
├── index.html
├── vite.config.ts
└── package.json
```

## Server Setup

The example server (`packages/cli/example-server.ts`) is configured with registry hooks:

```typescript
import {
  DurableStreamTestServer,
  createRegistryHooks,
} from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 8787,
  host: `127.0.0.1`,
})

// Enable automatic registry stream maintenance
const hooks = createRegistryHooks(server.store)
server.options.onStreamCreated = hooks.onStreamCreated
server.options.onStreamDeleted = hooks.onStreamDeleted

await server.start()
```

This ensures all stream operations (from any client) are tracked in the registry.

## Build

```bash
pnpm build
```

Outputs to `dist/` directory.

## Notes

- The server must be running on `http://localhost:8787` for the UI to work
- Stream paths are automatically prefixed with `/v1/stream/`
- The `__registry__` stream is excluded from the stream list
- Press Enter in the write box to send messages (Shift+Enter for newlines)

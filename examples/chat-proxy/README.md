# Durable Proxy Demo

A chat application demonstrating **TanStack AI** with **Durable Proxy** for resumable AI streaming.

## Running the Demo

### Prerequisites

- Node.js 22+
- An Anthropic API key

### Setup

1. Clone and install dependencies:

```bash
cd chat-app
npm install
```

2. Create a `.env` file with your Anthropic API key:

```bash
ANTHROPIC_API_KEY=your-api-key-here
```

3. Start the backend servers (durable proxy + API backend):

```bash
npm run dev:server
```

4. In another terminal, start the frontend:

```bash
npm run dev
```

5. Open http://localhost:5173

### Test Resilience

1. Send a message and wait for the response to start streaming
2. **Refresh the page mid-stream**
3. Watch the response resume from where it left off!

## How It Works

### Switching TanStack AI to Use Durable Proxy

TanStack AI's `useChat` hook accepts a `connection` prop that defines how to communicate with the AI backend. By default, it uses a simple fetch-based connection. To add durability, we create a custom connection using `createDurableFetch`:

```typescript
import { useChat } from "@tanstack/ai-react"
import { createDurableFetch } from "@durable-streams/proxy/client"

// Create a durable fetch instance
const durableFetch = createDurableFetch({
  proxyUrl: "http://localhost:4000/v1/proxy/chat",
  storage: localStorage, // Stores stream credentials for resume
  autoResume: true, // Automatically resume incomplete streams
})

// Create a TanStack AI compatible connection adapter
function createDurableConnection(apiUrl: string, getStreamKey: () => string) {
  return {
    async *connect(messages, data, abortSignal): AsyncIterable<StreamChunk> {
      const response = await durableFetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          messages,
          stream: true,
        }),
        stream_key: getStreamKey(), // Unique key for this stream
        signal: abortSignal,
      })

      // Parse SSE stream and yield chunks...
      const reader = response.body.getReader()
      // ... streaming logic
    },
  }
}

// Use in your component
function Chat() {
  const connection = useMemo(
    () => createDurableConnection(apiUrl, getStreamKey),
    [apiUrl]
  )

  const { messages, sendMessage, isLoading } = useChat({
    connection, // <- Custom durable connection
    initialMessages,
  })

  // ... render chat UI
}
```

### Key Concepts

1. **Stream Key**: Each stream needs a unique identifier. The demo uses `{conversationId}-msg-{messageCount}` to ensure each message has its own resumable stream. The proxy uses this key to create and identify streams.

2. **Stream Credentials**: When the proxy creates a stream, it returns credentials (stream URL and read token) in response headers. The client library stores these in localStorage, enabling direct reconnection to the proxy server without going through the initial request again.

3. **Auto Resume**: When `autoResume: true`, the client automatically checks localStorage for incomplete streams on mount. If found, it connects directly to the proxy server to resume from the last received byte.

## Project Structure

```
chat-app/
├── src/
│   ├── routes/
│   │   ├── __root.tsx          # TanStack Router root layout
│   │   └── index.tsx           # Home route with chat component
│   ├── components/
│   │   └── DurableChat.tsx     # Main chat component with durable proxy
│   ├── main.tsx                # Entry point
│   ├── router.tsx              # Router setup
│   └── dev-server.ts           # Backend servers (durable proxy + API)
├── vite.config.ts              # Vite config with TanStack Router plugin
└── package.json
```

## Scripts

- `npm run dev` - Start Vite dev server (frontend)
- `npm run dev:server` - Start backend servers
- `npm run build` - Build for production
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript type checking

## Technologies

- [TanStack AI](https://tanstack.com/ai) - AI chat hooks for React
- [TanStack Router](https://tanstack.com/router) - Type-safe routing
- [Durable Proxy](https://github.com/anthropics/durable-streams) - Resumable streaming proxy
- [Vite](https://vitejs.dev/) - Build tool
- [React 19](https://react.dev/) - UI framework

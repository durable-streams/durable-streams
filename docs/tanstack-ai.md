# TanStack AI

Use the TanStack AI transport from `@durable-streams/proxy/transports` when you want durable, resumable streaming without rewriting your upstream AI endpoint around Durable Streams directly.

This path sits on top of the durable proxy.

## Install

```bash
pnpm add @durable-streams/proxy
```

## Create the adapter

```typescript
import { createDurableAdapter } from "@durable-streams/proxy/transports"

const adapter = createDurableAdapter("https://api.example.com/api/chat", {
  proxyUrl: "https://my-proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  getRequestId: (_messages, data) => data?.conversationId ?? "default",
})
```

## Connect

```typescript
const connection = await adapter.connect({
  url: "https://api.example.com/api/chat",
  body: { messages },
})

const reader = connection.stream.getReader()
```

## Abort

```typescript
await adapter.abort()
```

## How it works

- The adapter sends the upstream request through the durable proxy.
- The proxy persists the streaming response into a durable stream.
- On reconnect, the client resumes from the saved offset instead of restarting the generation.

If you are using Vercel AI SDK instead of TanStack AI, use [Vercel AI SDK](vercel-ai-sdk.md).

## More

- [Proxy](proxy.md) for the server and client pieces underneath this adapter
- [Proxy README](https://github.com/durable-streams/durable-streams/blob/main/packages/proxy/README.md)

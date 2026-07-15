# Chat Cloudflare example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/durable-streams/durable-streams/tree/main/examples/chat-cloudflare)

Same app as [`chat-tanstack`](../chat-tanstack), but built for Cloudflare with the [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/): the TanStack Start app and the Durable Streams server (`@durable-streams/server-cloudflare`) run in a single Worker. Server routes call the streams handler in-process (one Durable Object per stream), and the browser reads through the `/api/chat-stream` proxy — the raw stream protocol is never exposed publicly. The Worker fails closed unless `CHAT_AUTH_TOKEN` is configured, and requires that bearer token for every request; use a real identity/session layer for a multi-user product. Chat metadata for the sidebar is stored in a durable stream too (`chats/index`), since Workers have no filesystem.

To expose direct protocol access instead, mount `createStreamsHandler()` under a route in `src/server.ts` — but protect it first (set an `AUTH_TOKEN` secret for the built-in bearer-token check, or pass a custom `auth` hook), since the raw protocol lets clients create, append to, read, and delete arbitrary streams.

## Setup

Copy `.dev.vars.example` to `.dev.vars` and set your OpenAI key:

```sh
cp .dev.vars.example .dev.vars
```

Then:

```sh
pnpm dev
```

One process: vite serves the app and workerd runs the Worker with a local Durable Object. The app runs at http://localhost:3002.

## Deploying

The example deploys as a single Worker — app, streams handler, and Durable Objects together:

```sh
pnpm run deploy
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CHAT_AUTH_TOKEN
```

Or use the Deploy to Cloudflare button above (then set the `OPENAI_API_KEY` secret in the dashboard).

## Environment variables

- `OPENAI_API_KEY` (required): OpenAI API key used by `@tanstack/ai-openai`
- `CHAT_AUTH_TOKEN` (required): bearer token protecting the app, transcripts, index, and model invocation

## Request/response contract

- Client posts to `/api/chat`
- Browser reads from `/api/chat-stream`; this route resolves the stream from the chat id and forwards the response
- Server returns an empty success response:
  - `202` in immediate mode
  - `200` in await mode

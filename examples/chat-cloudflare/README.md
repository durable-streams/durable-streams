# Chat Cloudflare example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/durable-streams/durable-streams/tree/main/examples/chat-cloudflare)

Same app as [`chat-tanstack`](../chat-tanstack), but built for Cloudflare with the [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/): the TanStack Start app and the Durable Streams server (`@durable-streams/server-cloudflare`) run in a single Worker. `src/server.ts` routes `/streams/*` to the streams handler (one Durable Object per stream) and everything else to TanStack Start.

After deploying, set your OpenAI key on the Worker: `npx wrangler secret put OPENAI_API_KEY` (or add it as a secret in the dashboard).

`pnpm dev` runs it all in one process — vite serves the app and workerd runs the Worker with a local Durable Object, no separate streams server. Chat metadata for the sidebar is stored in a durable stream too (`chats/index`), since Workers have no filesystem.

## Setup

Copy `.dev.vars.example` to `.dev.vars` and set your OpenAI key:

```sh
cp .dev.vars.example .dev.vars
```

Then:

```sh
pnpm dev
```

The app runs at http://localhost:3002 and streams live at http://localhost:3002/streams/.

## Environment variables

- `OPENAI_API_KEY` (required): OpenAI API key used by `@tanstack/ai-openai` — set in `.dev.vars` locally, or as a Worker secret in production
- `DURABLE_STREAMS_WRITE_URL` or `DURABLE_STREAMS_URL` (optional): base URL used to create/write per-request durable streams (defaults to the local `/streams` mount at `http://localhost:3002/streams`)
- `DURABLE_STREAMS_READ_URL` (optional): base URL used by the server-side read proxy (falls back to `DURABLE_STREAMS_URL`)
- `DURABLE_STREAMS_WRITE_BEARER_TOKEN` / `DURABLE_STREAMS_READ_BEARER_TOKEN` (optional): bearer tokens for server-side writes/reads against a protected streams server

## Deploying

A deployed Worker cannot `fetch()` its own hostname, so the same-Worker `/streams` mount is a dev convenience. For production, deploy the streams server as its own Worker and point this app at it:

1. Deploy the streams server: `pnpm --filter @durable-streams/server-cloudflare exec wrangler deploy` (optionally set an `AUTH_TOKEN` secret on it)
2. Deploy this app with `pnpm run deploy`, setting on it:
   - secret `OPENAI_API_KEY`
   - var `DURABLE_STREAMS_URL=https://<streams-worker>.workers.dev`
   - secret `DURABLE_STREAMS_WRITE_BEARER_TOKEN=<AUTH_TOKEN>` if you set one

## Request/response contract

- Client posts to `/api/chat`
- Browser reads from `/api/chat-stream`; this route forwards to Durable Streams with server-side auth headers
- Server returns an empty success response:
  - `202` in immediate mode
  - `200` in await mode

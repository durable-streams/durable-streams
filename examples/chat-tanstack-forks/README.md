# Chat with forks — TanStack Start + Durable Streams

This example demonstrates conversation branching backed by Durable Streams.

## What it shows

- One durable stream per chat session
- Fork-point markers stored in the main stream as `CUSTOM` chunks
- Recursive conversation branching (fork from any completed message, including inherited ones)
- A left-hand fork tree stored in browser localStorage
- SSR snapshot materialization that includes fork-point metadata
- Resilient reload: both the active chat and tree survive page refresh

## How it works

**Message history** lives in Durable Streams and is fully durable. Each chat session is an append-only JSON stream containing TanStack AI chunks plus fork-point markers.

**Tree state** lives in browser localStorage. It tracks chat relationships, titles, and the currently active branch. This is intentionally browser-local — the full tree is not reconstructable from a shared URL alone.

**Fork-point markers** are `CUSTOM` chunks written to the stream after each completed message. They record the exact durable offset at the message boundary, enabling precise forking.

**Forking** creates a new durable stream using `Stream-Forked-From` / `Stream-Fork-Offset` headers. The server replays inherited fork-point markers into the child stream so the child can fork again from inherited messages.

## Required environment variables

- `OPENAI_API_KEY`: OpenAI API key used by `@tanstack/ai-openai`
- `DURABLE_STREAMS_WRITE_URL` or `DURABLE_STREAMS_URL`: base URL for durable streams

## Optional environment variables

- `DURABLE_STREAMS_READ_URL`: base URL for the server-side read proxy
- `DURABLE_STREAMS_WRITE_BEARER_TOKEN`: bearer token for server-side writes
- `DURABLE_STREAMS_READ_BEARER_TOKEN`: bearer token for server-side reads

## Running locally

```bash
# From the repo root
pnpm install

# Set your OpenAI key
cp examples/chat-tanstack-forks/.env.example examples/chat-tanstack-forks/.env
# Edit .env to add OPENAI_API_KEY

# Start the dev server and durable streams server
cd examples/chat-tanstack-forks
pnpm dev
```

The app runs on `http://localhost:3002`.

## Deploying to Cloudflare Workers

The app is configured for Cloudflare Workers via Nitro's `cloudflare_module` preset.

### Build and preview locally

```bash
# Copy and fill in .dev.vars for local Wrangler preview
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your secrets

pnpm preview:cloudflare
```

### Deploy

```bash
# Login to Cloudflare (one-time)
pnpm exec wrangler login

# Deploy
pnpm deploy:cloudflare
```

### Environment configuration

**Plain vars** are set in `wrangler.jsonc` under `vars`:

- `DURABLE_STREAMS_URL` — base URL for durable streams
- `OPENAI_MODEL` — model name (default: `gpt-4o-mini`)

**Secrets** must be set via the Cloudflare dashboard or `wrangler secret put`:

- `OPENAI_API_KEY`
- `DURABLE_STREAMS_WRITE_BEARER_TOKEN`
- `DURABLE_STREAMS_READ_BEARER_TOKEN`

### Custom domain

Set up a custom domain (e.g. `fork-ai-chat.examples.electric-sql.com`) via the Cloudflare dashboard under Workers & Pages > your worker > Settings > Domains & Routes.

## Limitations

- Tree organization is browser-local (localStorage). Clearing storage loses the tree but not the message history.
- Direct deep-links restore only the active branch, not the full fork ancestry.
- Only text messages are forkable in this demo (no tool calls or multi-modal parts).

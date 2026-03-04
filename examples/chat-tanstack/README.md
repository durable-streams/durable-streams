# Chat TanStack Example

This example uses `@durable-streams/tanstack-ai-transport`.

## Required environment variables

- `OPENAI_API_KEY`: OpenAI API key used by `@tanstack/ai-openai`
- `DURABLE_STREAMS_WRITE_URL` or `DURABLE_STREAMS_URL`: base URL used to create/write per-request durable streams

## Optional environment variables

- `DURABLE_STREAMS_READ_URL`: base URL used by the server-side read proxy (falls back to `DURABLE_STREAMS_URL`)
- `DURABLE_STREAMS_WRITE_BEARER_TOKEN`: bearer token used only for server-side writes
- `DURABLE_STREAMS_READ_BEARER_TOKEN`: bearer token used only for server-side reads (falls back to write token)

## Request/response contract

- Client posts to `/api/chat`
- Server returns a same-origin proxy stream URL: `/api/chat-stream?path=<stream-path>`
- Browser reads from `/api/chat-stream`; this route forwards to Durable Streams with server-side auth headers
- Server returns:
  - `201` + `Location` + `{ streamUrl }` (immediate mode)
  - `200` + `Location` + `{ streamUrl, finalOffset }` (await mode)

# Chat AI SDK Example

This example uses `@durable-streams/aisdk-transport` with `useChat` from the Vercel AI SDK.

## Required environment variables

- `OPENAI_API_KEY`: OpenAI API key used by `@ai-sdk/openai`
- `DURABLE_STREAMS_WRITE_URL` or `DURABLE_STREAMS_URL`: base URL used to create/write per-request durable streams

## Optional environment variables

- `DURABLE_STREAMS_READ_URL`: base URL used by the server-side read proxy (falls back to `DURABLE_STREAMS_URL`)
- `DURABLE_STREAMS_WRITE_BEARER_TOKEN`: bearer token used only for server-side writes
- `DURABLE_STREAMS_READ_BEARER_TOKEN`: bearer token used only for server-side reads (falls back to write token)

## Local development

- `pnpm --filter @durable-streams/example-chat-aisdk dev`
- This runs the Next.js app on `http://localhost:3000` and the local Durable Streams server on `http://localhost:4437`

## Request/response contract

- Client sends chat requests to `POST /api/chat`
- Server writes AI chunks to Durable Streams and returns stream location:
  - `201` + `Location` + `{ streamUrl }` (immediate mode)
  - `200` + `Location` + `{ streamUrl, finalOffset }` (await mode)
- `streamUrl` points to the same-origin proxy route: `/api/chat-stream?path=<stream-path>`
- Browser reads from `/api/chat-stream`; this route forwards to Durable Streams with server-side auth headers

## Stream resume flow

- `useChat({ resume: true })` triggers `GET /api/chat/:id/stream` on page load
- If there is an active generation, server returns `200` + `Location` + `{ streamUrl }`
- If no generation is active, server returns `204 No Content`
- When generation completes, the server persists final messages and clears `activeStreamId`

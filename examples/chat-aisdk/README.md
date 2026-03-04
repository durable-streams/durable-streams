# Chat AI SDK Example

Minimal AI SDK chat demo without Durable Streams transport integration.

## Required environment variables

- `OPENAI_API_KEY`: OpenAI API key used by `@ai-sdk/openai`

## Local development

- `pnpm --filter @durable-streams/example-chat-aisdk dev`
- This runs the Next.js app on `http://localhost:3000`

## Request/response contract

- Client sends chat requests to `POST /api/chat`
- Server returns UI message stream chunks directly from `toUIMessageStreamResponse(...)`

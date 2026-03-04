# Chat TanStack Example

Minimal TanStack chat demo without Durable Streams transport integration.

## Required environment variables

- `OPENAI_API_KEY`: OpenAI API key used by `@tanstack/ai-openai`

## Request/response contract

- Client posts to `/api/chat`
- Server returns SSE chunks directly from `toServerSentEventsResponse(...)`

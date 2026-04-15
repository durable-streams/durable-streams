---
"@durable-streams/tanstack-ai-transport": patch
---

docs(tanstack-ai): headers on connection, full read proxy, auth separation

- Document that custom headers (API keys) go on `durableStreamConnection`, not `useChat`
- Add full inline read proxy implementation (was "see examples/" which agents can't access)
- Separate DS auth from AI auth with clear table
- Add user-supplied API key pattern for apps with settings UI
- Recommend query params over dynamic route segments for chat id

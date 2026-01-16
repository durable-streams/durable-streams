---
'durable-streams': patch
'durable-streams-py': patch
'durable-streams-go': patch
'durable-streams-rust': patch
'durable-streams-swift': patch
'durable-streams-java': patch
'durable-streams-php': patch
'durable-streams-rb': patch
---

Remove "auto" live mode from all clients in favor of explicit mode selection. TypeScript and Python now use `live: true` for auto-select behavior. Fix Java hidden state by removing contentTypeCache. Fix Swift by removing stub flush/close methods from DurableStream.

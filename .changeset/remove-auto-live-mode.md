---
'@durable-streams/client': patch
'@durable-streams/client-py': patch
---

Remove "auto" live mode from all clients in favor of explicit mode selection. TypeScript and Python now use `live: true` for auto-select behavior. Go, Rust, Swift, Java, PHP, and Ruby clients also updated. Fix Java hidden state by removing contentTypeCache. Fix Swift by removing stub flush/close methods from DurableStream.

---
"@durable-streams/aisdk-transport": patch
---

docs(vercel-ai-sdk): inline read proxy, remove broken examples/ refs

- Inline the full read proxy implementation (hop-by-hop header stripping,
  query-param forwarding, Authorization header injection) so agents don't
  need to follow `examples/chat-aisdk/...` references that don't ship in
  the npm package
- Drop prose "Source: examples/chat-aisdk/..." lines that pointed at files
  only present in the monorepo, not in the published skill

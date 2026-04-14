---
"@durable-streams/tanstack-ai-transport": patch
---

docs(tanstack-ai): show anthropicText adapter, warn against raw SDK usage

Updated the skill to use `anthropicText` from `@tanstack/ai-anthropic` as the primary example instead of `openaiText`. Added explicit warning against calling LLM SDKs directly — agents were bypassing the adapter and getting 400 errors from message format mismatches.

---
"@durable-streams/tanstack-ai-transport": patch
---

Add a `fetchClient` option to `DurableStreamTarget` and `materializeSnapshotFromDurableStream` so server-side helpers can talk to a durable streams server through a custom fetch — e.g. a Cloudflare service binding or an in-process handler instead of public HTTP.

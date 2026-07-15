---
"@durable-streams/server-cloudflare": patch
---

`createStreamsHandler` hardening: when an auth gate is active (a custom `auth` hook or `AUTH_TOKEN` set), publicly-cacheable catch-up responses are rewritten to `Cache-Control: no-store` so shared caches never store authenticated data; and `cors: false` now also strips the CORS headers the Durable Object adds to stream responses.

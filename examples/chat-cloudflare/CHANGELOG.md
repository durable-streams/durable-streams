# @durable-streams/example-chat-cloudflare

## 0.0.1

### Patch Changes

- Add a Cloudflare Workers and Durable Objects server with secure routing, durable fork lifecycle handling, bounded reads, sliding TTL support, and conformance coverage. Add custom server-side fetch support to the TanStack AI transport and a deployable Cloudflare chat example. Harden fork recovery across existing servers and require fail-closed authentication and path-safe identifiers in the chat examples. ([#392](https://github.com/durable-streams/durable-streams/pull/392))

- Updated dependencies [[`a4d31bc`](https://github.com/durable-streams/durable-streams/commit/a4d31bcca01794aa81a5e482b7401670077cc78e)]:
  - @durable-streams/server-cloudflare@0.1.1
  - @durable-streams/tanstack-ai-transport@0.0.9
  - @durable-streams/client@0.2.6

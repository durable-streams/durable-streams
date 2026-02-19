---
layout: home

hero:
  name: Durable Streams
  text: Persistent, resumable event streams over HTTP
  tagline: Exactly-once semantics via idempotent producers, built for real-time application data and AI streaming.
  actions:
    - theme: brand
      text: Read the Docs
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/durable-streams/durable-streams
    - theme: alt
      text: Electric Ecosystem
      link: https://electric-sql.com

features:
  - title: Resumable by design
    details: Consumers read by offset and reconnect without losing position, making stream processing reliable across network interruptions.
  - title: Exactly-once writes
    details: Producers use idempotency keys (`producerId`, `epoch`, `seq`) to safely retry writes without duplicating events.
  - title: Real-time delivery modes
    details: Long-poll and SSE live modes support progressive delivery for UIs, agents, and backend workers.
  - title: Multi-language clients
    details: Official clients cover TypeScript, Python, Go, Elixir, .NET, Swift, PHP, Java, Rust, and Ruby.
  - title: Production-ready server path
    details: Start with the development server and deploy with the Caddy plugin or managed infrastructure.
  - title: Part of Electric
    details: Durable Streams is developed alongside Electric sync primitives. Visit Electric for cloud, ecosystem, and related tools.
---

## Start here

- New to Durable Streams? Begin with [Introduction](/introduction).
- Want a quick setup? Go to [Getting Started](/getting-started).
- Need protocol details? Read the [Protocol Specification](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md).

## Electric ecosystem

Durable Streams is part of the broader Electric ecosystem of sync and local-first infrastructure.

- [Electric main site](https://electric-sql.com)
- [Electric Cloud](https://electric-sql.com/cloud)
- [Electric Discord](https://discord.electric-sql.com)

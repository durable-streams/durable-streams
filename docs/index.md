---
layout: home

hero:
  name: Durable Streams
  text: Reliable client streaming, solved
  tagline: A persistent stream primitive and HTTP protocol for reliable, resumable, real-time data streaming into client applications.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Protocol Specification
      link: https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md
    - theme: alt
      text: GitHub
      link: https://github.com/durable-streams/durable-streams

features:
  - title: Ordered, replayable, resumable
    details: Resume cleanly from the last processed offset instead of restarting streams.
  - title: Plain HTTP delivery
    details: Works over standard HTTP with long-poll or SSE, plus CDNs and API gateways.
  - title: Exactly-once semantics
    details: Idempotent producer keys make retries safe and prevent duplicate writes.
  - title: Built for AI and sync
    details: Reliable transport for token streams, agent events, and client state sync.
  - title: Production-hardened
    details: Extracted from Electric and refined through real production use.
  - title: Composable foundation
    details: Use it directly, or layer protocols like State Protocol on top.
---

<HomeLanding />

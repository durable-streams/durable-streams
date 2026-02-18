# Use Cases

Durable Streams is a delivery primitive. The pattern is the same across use cases: consume events from backend systems -- databases, LLMs, Kafka, queues -- apply auth and transformation, then fan out to clients over HTTP using Durable Streams.

```
Backend Systems → Application Server → Durable Streams → Clients
(databases, LLMs,   (auth, shaping,      (durable delivery
 Kafka, queues)      transformation)       over HTTP)
```

## AI / LLM Streaming

Token streaming is the UI for chat and copilots. When the stream fails, the product fails -- even if the model did the right thing. Durable Streams lets you resume token streams across page refreshes, tab suspensions, and device switches instead of restarting expensive generations.

The [`@durable-streams/proxy`](../packages/proxy/README.md) package makes existing AI streaming APIs resumable with no code changes. It sits between your client and upstream AI services (OpenAI, Anthropic, etc.), persisting streaming responses to a durable store. If a connection drops, clients resume from where they left off rather than losing partial responses or re-running inference. The proxy includes transports for the [Vercel AI SDK](https://sdk.vercel.ai/) and [TanStack AI](https://tanstack.com/start/latest/docs/framework/react/ai).

## Agentic Apps

Agentic apps stream tool outputs, progress events, and partial results over long-running sessions. Request/response assumes two parties taking turns. Agentic apps have multiple agents and multiple users acting at once. That requires a shared log that everyone can read, resume, and react to -- a coordination model beyond request/response.

Durable Streams provides that shared log with replay and clean reconnect semantics. Multiple agents write to the same stream, multiple users subscribe, and everyone picks up from their last offset on reconnect. See the [Durable Sessions](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai) blog post and the [State Protocol](state.md) for the session pattern built on top of this.

## Database Synchronization

Stream row changes with guaranteed ordering and resumability. This is the mechanism [Electric](https://electric-sql.com/) uses to ship real-time Postgres updates to clients -- millions of state changes delivered reliably every day. Clients subscribe to a stream of changes, persist their offset, and catch up from where they left off after any disconnection.

Works with the [State Protocol](state.md) for insert/update/delete semantics on top of the raw stream.

## Event Sourcing

Append-only streams are a natural fit for event sourcing. Clients can replay the full event log from any point in time to reconstruct state, and subscribe for live updates as new events arrive. Exactly-once writes via idempotent producers ensure no duplicate events, and offset-based resumption means consumers never miss or re-process events.

## Real-time Collaboration

Deliver CRDT and operational transform updates with replayable history and clean reconnects. The [`@durable-streams/y-durable-streams`](../packages/y-durable-streams/README.md) package provides a Yjs provider for collaborative editing over Durable Streams. Document history is stored in the stream itself, and presence/awareness data flows over a separate stream.

No WebSocket infrastructure is needed -- the provider uses SSE and long-poll transports over standard HTTP, making it simple to deploy behind load balancers and CDNs.

## Real-time Dashboards

Stream live data feeds to dashboards with guaranteed delivery. Offset-based URLs make reads CDN-cacheable, so thousands of concurrent viewers watching the same dashboard become a single upstream request via request collapsing.

See the [Wikipedia events example](../examples/state/) -- a Solid.js dashboard showing live Wikipedia edits with faceted filtering, built on the State Protocol.

## Background Job Progress

Track long-running tasks by streaming progress events to a durable stream. Clients subscribe to a job's stream and see real-time progress updates. If they disconnect and reconnect -- whether from a page refresh, network interruption, or switching devices -- they resume from where they left off and catch up on any progress they missed.

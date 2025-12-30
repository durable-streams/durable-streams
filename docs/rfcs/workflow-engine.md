# RFC: Workflow Engine for Durable Streams

## Summary

_To be written last._

## Background

### Durable Streams

Durable Streams is an HTTP-based protocol for reliable, resumable data streaming. Clients can disconnect and reconnect at any point, resuming from an offset without data loss. The protocol supports multiple languages (TypeScript, Go, Python) and provides exactly-once delivery guarantees.

### State Protocol

The State Protocol extends Durable Streams with structured change events (insert, update, delete). It enables real-time synchronization of application state across multiple clients. The `@durable-streams/state` package provides `StreamDB`, which materializes these events into reactive collections that integrate with UI frameworks via TanStack DB.

### Existing Workflow Engines

Several workflow engines exist for building durable, multi-step applications:

**Inngest** provides `step.run()`, `step.sleep()`, and `step.waitForEvent()` primitives. Steps are identified by explicit string IDs. Functions are triggered by events and execute on serverless infrastructure.

**Temporal** offers a comprehensive workflow orchestration platform with strong determinism guarantees. Workflows replay from event history to rebuild state. The system provides replacement APIs for non-deterministic operations and supports replay testing in CI.

**Cloudflare Workflows** provides `step.do()`, `step.sleep()`, and `step.waitForEvent()` for durable execution on Workers. Their `waitForEvent` primitive enables human-in-the-loop patterns with configurable timeouts up to 365 days.

**Vercel Workflow Development Kit** uses `"use workflow"` and `"use step"` directives with build-time transformation. It includes `sleep()` and `defineHook()` for external events, plus a "Worlds" abstraction for different runtime environments.

All of these engines focus primarily on server-side orchestration. Client integration requires separate implementation — the workflow engine doesn't know about the UI, and the UI polls or subscribes to learn about workflow state.


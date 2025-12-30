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

## Problem

### The Client Integration Gap

Existing workflow engines treat the browser as an afterthought. When a workflow needs human input — approving a request, filling out a form, confirming an action — developers must:

1. Build a separate API layer to expose workflow state
2. Implement polling or WebSocket subscriptions in the client
3. Create forms that POST back to trigger workflow resumption
4. Handle the edge cases: what if the user submits twice? What if the workflow moved on?

This creates friction for use cases that are increasingly common:

- **Human-in-the-loop AI agents**: An agent generates a response, pauses for user confirmation, then continues
- **Multi-step forms**: A wizard where each step might trigger server-side validation or processing
- **Approval workflows**: Expense reports, document reviews, access requests
- **Interactive onboarding**: Collect information progressively, with server-side logic between steps

### Why This Matters Now

The State Protocol already solves real-time client synchronization. Adding workflow primitives creates a complete solution: server-side logic that can pause, resume, and coordinate with browser clients through a single abstraction.

Instead of workflow engine + custom API + custom client subscriptions, developers get one system where the workflow can directly request input from the browser and the browser sees workflow state changes instantly.

### Constraints

1. **Protocol-first**: The solution must be language-agnostic. A Python workflow should work with a React client.
2. **Runtime-agnostic**: Workflows must run on serverless functions, long-running servers, or edge runtimes.
3. **Deterministic replay**: Workflows must survive restarts and redeploys by replaying from the event log.
4. **No build-time magic**: Unlike Vercel's `"use workflow"` directive, this should work without special compilation steps.


# RFC: Workflow Engine for Durable Streams

## Summary

Existing workflow engines (Inngest, Temporal, Cloudflare Workflows, Vercel WDK) provide durable execution primitives but treat browser integration as an afterthought — developers must build separate APIs and client subscriptions to enable human-in-the-loop workflows. This RFC proposes a workflow engine built on Durable Streams and the State Protocol, where workflows can make RPC calls that pause execution until a browser client responds, and clients observe workflow state changes in real-time through the same stream. The result is a unified system for building interactive workflows — from AI agent approval flows to multi-step forms — without custom plumbing between server and client.

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

## Proposal

### Architecture

The workflow engine is a thin protocol layer on top of the State Protocol:

```
┌─────────────────────────────────────────────────────────┐
│  Application Layer                                      │
│  Custom RPC methods (approveExpense, selectProduct)     │
├─────────────────────────────────────────────────────────┤
│  Core Workflow Primitives                               │
│  step.run(), sleep(), waitForEvent(), rpc()             │
├─────────────────────────────────────────────────────────┤
│  Workflow Protocol                                      │
│  Event types, replay semantics, determinism rules       │
├─────────────────────────────────────────────────────────┤
│  State Protocol + Durable Streams                       │
│  Event log, real-time sync, multi-client                │
└─────────────────────────────────────────────────────────┘
```

A workflow instance is identified by a stream URL. All workflow events — step completions, sleep timers, input requests, responses — are appended to that stream. The workflow executor replays from the stream to rebuild state, then continues execution.

### Core Primitives

Following conventions established by Inngest, Cloudflare, and Vercel:

#### `step.run(id, fn)`

Execute a function as a durable, retriable step.

```typescript
const user = await step.run("fetch-user", async () => {
  return await db.users.findById(userId);
});
```

- If the step previously completed, returns the cached result (replay)
- If the step fails, retries with configurable backoff
- After max retries, workflow moves to error state

#### `sleep(duration)`

Pause the workflow for a duration without consuming compute.

```typescript
await sleep("7 days");
// Workflow resumes here after 7 days
```

#### `waitForEvent(id, options)`

Pause until an external event arrives.

```typescript
const approval = await waitForEvent("manager-approval", {
  timeout: "48 hours",
});

if (approval.decision === "approved") {
  // continue
}
```

Events are sent to the workflow by appending to the stream with a matching event type.

### RPC-Style Client Interaction

Beyond generic `waitForEvent`, workflows can define RPC methods that clients call. This follows the pattern established by Cloudflare's Cap'n Proto-based Workers RPC.

```typescript
// Server: define an RPC call and wait for response
const expense = await rpc.call("approveExpense", {
  amount: 1500,
  description: "Team offsite dinner",
  submittedBy: "alice@example.com",
});

if (expense.approved) {
  await step.run("process-reimbursement", () => processReimbursement(expense));
}
```

```typescript
// Client: sees pending RPC, renders appropriate UI, sends response
const workflow = useWorkflow({ url: workflowStreamUrl });

// workflow.pendingRpc contains:
// { method: "approveExpense", args: { amount: 1500, description: "...", ... } }

// Client renders domain-specific approval UI
// On submit, client responds:
workflow.respond({ approved: true, approverNotes: "Looks good" });
```

Applications define their own RPC methods with domain-specific types. The workflow SDK provides the primitive; the application defines semantics like `approveExpense()`, `selectProduct()`, `confirmIdentity()`, etc.

### Step Identification

Steps are identified by **explicit string IDs**, following Inngest's approach. This ensures stable replay across code changes.

```typescript
// Good: explicit ID survives refactoring
await step.run("send-welcome-email", () => sendEmail(user));

// Bad: positional/implicit IDs break when code changes
await step.run(() => sendEmail(user)); // Don't do this
```

For loops, the SDK maintains a counter per ID:

```typescript
for (const item of items) {
  // Becomes "process-item:0", "process-item:1", etc.
  await step.run("process-item", () => processItem(item));
}
```

### Determinism

Workflows must be deterministic — replaying with the same event history must produce the same sequence of step calls.

**Rules:**

1. All side effects must be inside `step.run()`
2. No `Math.random()` or `Date.now()` in workflow code (use `workflow.random()`, `workflow.now()`)
3. No reading external state that might change between replays
4. Step IDs and call order must be stable

**Enforcement:**

1. **Development mode**: Warn when detecting non-deterministic patterns (e.g., `Math.random` usage)
2. **Runtime detection**: During replay, if a step ID doesn't match the expected sequence, throw an error
3. **Replay testing**: Support running historical event logs against current code in CI

### Retry and Error Handling

Following conventions from existing engines:

```typescript
await step.run(
  "call-external-api",
  async () => {
    return await externalApi.call();
  },
  {
    retries: 3,
    backoff: "exponential", // or "linear", "constant"
    maxBackoff: "1 hour",
  }
);
```

When a step exhausts retries, the workflow moves to an error state. The error is recorded in the stream. Clients observing the workflow see the error state and can display appropriate UI.

### Wire Protocol

The workflow protocol defines event types appended to the stream. This is a thin layer on the State Protocol.

**Core event types** (high-level, formal spec TBD):

```typescript
// Step lifecycle
{ type: "workflow:step_started", stepId: string, name: string }
{ type: "workflow:step_completed", stepId: string, result: any }
{ type: "workflow:step_failed", stepId: string, error: Error, attempt: number }

// Flow control
{ type: "workflow:sleeping", until: timestamp }
{ type: "workflow:waiting", eventType: string, timeout?: timestamp }

// External events
{ type: "workflow:event", eventType: string, payload: any }

// Terminal states
{ type: "workflow:completed", result: any }
{ type: "workflow:failed", error: Error }
```

The formal protocol specification will be developed as a separate document, following the pattern of PROTOCOL.md and STATE-PROTOCOL.md.

### Client Integration

The client SDK wraps StreamDB with workflow-specific state:

```typescript
const workflow = useWorkflow({ url: "https://example.com/v1/stream/workflow-123" });

// Workflow state
workflow.status; // "running" | "sleeping" | "waiting" | "completed" | "failed"
workflow.pendingRpc; // Current RPC call waiting for response, if any
workflow.error; // Error details if failed

// Send response to pending RPC
workflow.respond(value);

// Send arbitrary event
workflow.sendEvent("approval", { decision: "approved" });

// Access underlying StreamDB for custom state
workflow.db.collections.myCustomState;
```

No default UI rendering — the client exposes data through TanStack DB, and developers build their own UI.

### Multi-Language Support

The workflow protocol is language-agnostic. Initial implementation:

- **TypeScript SDK**: Full implementation (server + client)
- **Python SDK**: Thin wrapper for server-side workflow execution
- **Go SDK**: Thin wrapper for server-side workflow execution

All SDKs read/write the same event types to the stream, enabling cross-language workflows (e.g., Python workflow with React client).

### Open Questions

Areas requiring prototyping to resolve:

1. **Determinism detection**: What specific patterns should dev mode detect? How aggressive should runtime enforcement be?

2. **RPC type safety**: How do we ensure type safety between server RPC definitions and client rendering? Schema generation?

3. **Timeout handling**: When `waitForEvent` times out, should it throw, return null, or support a default value?

4. **Concurrent steps**: Should there be a `step.parallel()` primitive, or is `Promise.all()` with multiple `step.run()` sufficient?

## Definition of Success

This is an early-stage exploration. Success is qualitative, not quantitative.

### Can we build something compelling?

The prototype should enable building a real application that demonstrates the value proposition: a workflow that pauses for human input, with the client seeing state changes in real-time, without custom API plumbing.

Example applications to validate:
- Human-in-the-loop AI agent (agent proposes action, user approves/rejects)
- Multi-step onboarding flow with server-side validation between steps
- Expense approval workflow with manager notification and response

### Do developers get excited?

When showing the prototype to developers familiar with existing workflow engines (Inngest, Temporal, etc.), do they recognize the value of tight client integration? Do they have use cases that would benefit from this?

### Does it feel simpler than alternatives?

For use cases involving browser interaction, the workflow + client code should be meaningfully simpler than the equivalent built with Inngest/Temporal plus custom API endpoints and client subscriptions.


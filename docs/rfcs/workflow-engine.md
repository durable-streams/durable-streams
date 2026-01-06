# RFC: TanStack Workflow

## Summary

**TanStack Workflow** brings durable execution to the TanStack ecosystem — workflow functions that survive crashes, can sleep for days, and pause for human input, with first-class client integration through TanStack DB.

Most workflow engines are excellent at durability and mediocre at interactive state. The workflow history is already an event stream — so let the browser be a first-class consumer and participant. This inverts the usual "server owns truth, UI bolts on" pattern.

Existing workflow engines now offer human-in-the-loop primitives: Inngest has Realtime streaming, Cloudflare has `waitForEvent` with 365-day timeouts, Vercel WDK has hooks, Restate has awakeables, Trigger.dev has waitpoint tokens. But these systems still don't unify **durable event history + client-visible state + client response** into one protocol-first stream that clients can materialize directly.

TanStack Workflow fills this gap:

- **Host anywhere** — workflow functions run on any platform that can receive HTTP (Vercel, Cloudflare, Lambda, containers, VMs)
- **First-class TanStack Start integration** — if you're using Start, workflows are just server functions with durable execution
- **Client integration via TanStack DB** — reactive collections that update as the workflow progresses
- **TanStack AI integration** — agentic AI flows with human-in-the-loop approval, tool confirmation, and multi-step reasoning
- **Built on Durable Streams** — offset-resumable, CDN-cacheable, protocol-first

## Background

### TanStack Ecosystem

TanStack Workflow joins an ecosystem of framework-agnostic tools:

- **TanStack Start** — Full-stack React/Solid framework with server functions
- **TanStack DB** — Reactive collections that sync with backend state
- **TanStack AI** — Framework-agnostic AI toolkit with agentic flow support
- **TanStack Query** — Async state management for fetching and caching

Workflow functions integrate directly with TanStack Start's server function model. Client state flows through TanStack DB. AI agents built with TanStack AI can use workflows for durable multi-step reasoning with human oversight.

### Durable Streams

Durable Streams is an HTTP-based protocol for reliable, resumable data streaming. Clients can disconnect and reconnect at any point, resuming from an offset without data loss. The protocol supports multiple languages (TypeScript, Go, Python) and provides exactly-once delivery guarantees with CDN-friendly semantics.

### State Protocol

The State Protocol extends Durable Streams with structured change events (insert, update, delete). It enables real-time synchronization of application state across multiple clients. TanStack DB materializes these events into reactive collections that integrate with UI frameworks.

### Existing Workflow Engines

Several workflow engines exist for building durable, multi-step applications. Many now have explicit human-in-the-loop support:

**Inngest** provides `step.run()`, `step.sleep()`, and `step.waitForEvent()` primitives with explicit string IDs for memoization. Recently added **Inngest Realtime**: WebSocket streaming from functions to browsers with channels, topics, and subscription tokens. However, Realtime delivery is currently described as at-most-once and ephemeral.

**Temporal** offers comprehensive workflow orchestration with strong determinism guarantees. Workflows replay from event history to rebuild state. Supports external events and human-in-the-loop patterns, though browser integration remains an application concern.

**Cloudflare Workflows** provides `step.do()`, `step.sleep()`, and `step.waitForEvent()` for durable execution on Workers. Their `waitForEvent` supports timeouts up to 365 days, events can be buffered before the workflow reaches the wait, and waiting instances don't count toward concurrency limits. They publish explicit human-in-the-loop examples with Next.js UIs.

**Vercel Workflow Development Kit** uses `"use workflow"` and `"use step"` directives with build-time transformation. Hooks generate tokens that external systems use to resume workflows. The managed Vercel Workflow service builds on this.

**Restate** has "durable promises" via `ctx.awakeable()`, explicitly pitched for human-in-the-loop. Workflows suspend until the awakeable is resolved externally. Their model is also log-based replay.

**Trigger.dev** has waitpoint tokens completable via SDK or by POSTing to a callback URL, aimed at approvals and human oversight.

All of these engines now offer *some* way to pause for input and *some* way to show progress. But they don't unify durable event history with client-visible state into one stream that clients can materialize directly.

## Problem

### The Remaining Gap

Existing workflow engines have added human-in-the-loop primitives, but the integration story is still fragmented:

- **Inngest Realtime** streams to browsers, but delivery is at-most-once/ephemeral — disconnect and you lose events
- **Cloudflare/Vercel/Trigger.dev tokens** pause the workflow, but you still build a separate subscription model for UI state
- **Restate awakeables** are durable promises, but the browser integration story isn't "subscribe to the same history"

Developers still face friction:

1. Workflow engine provides durable execution and pause/resume
2. But you build a separate API layer to expose workflow state
3. And a separate subscription model (polling, WebSocket, SSE) for the client
4. And handle edge cases: duplicate submissions, stale state, reconnection

### The Unified Stream Opportunity

What if the workflow event log *is* the UI transport?

- Clients subscribe to the same durable stream the executor uses
- Disconnect and reconnect at any offset — no lost events
- Materialize workflow state into reactive collections (State Protocol)
- Respond to pending requests by appending to the stream

This is what Durable Streams + State Protocol enable. The "custom plumbing" disappears because there's only one stream, and both executor and UI consume it.

**Use cases that benefit:**

- **Human-in-the-loop AI agents**: Agent pauses for approval; client sees pending request via stream; response appends to same stream
- **Multi-step forms**: Each step is a workflow step; client materializes progress from stream
- **Approval workflows**: Manager sees pending approval in their stream view; response is durable
- **Interactive onboarding**: Server-side validation between steps; client state rebuilds from any offset

### Constraints

1. **Protocol-first**: The solution must be language-agnostic. A Python workflow should work with a React client.
2. **Runtime-agnostic**: Workflows must run on serverless functions, long-running servers, or edge runtimes.
3. **Deterministic replay**: Workflows must survive restarts and redeploys by replaying from the event log.
4. **No build-time magic**: Unlike Vercel's `"use workflow"` directive, this should work without special compilation steps.

### Differentiators

What makes this approach distinct from existing solutions:

1. **Durable UI stream**: The workflow event log is offset-resumable, CDN-cacheable, and shareable via URL. Unlike Inngest Realtime (at-most-once/ephemeral) or WebSocket subscriptions, clients can disconnect, reconnect at any offset, and rebuild complete state. The stream URL *is* the API.

2. **State Protocol projection**: Clients don't just receive events — they materialize workflow state into reactive collections via TanStack DB. No bespoke API endpoints; the client consumes the same event log as the executor and derives UI state automatically.

3. **Bidirectional input as awaitables**: RPC calls, external events, and human input all share a unified "awaitable" model. The workflow creates a pending awaitable; the client sees it in the stream; the response appends to the same stream. Both sides use one transport.

4. **Host anywhere**: Workflow code runs on any platform that can receive HTTP webhooks — Vercel, Cloudflare, AWS Lambda, containers, VMs. Durable Streams handles the event log and triggers; you bring your own compute. No platform lock-in.

## Proposal

### Architecture

The system has two main components: **Durable Streams** (event log + webhook triggers) and **workflow functions** (hosted anywhere).

```
+-----------------------------------------------------------------------------+
|                         DURABLE STREAMS SERVER                              |
|                                                                             |
|  +---------------------+      +---------------------------------------+     |
|  | Stream Storage      |      | Webhook Registry                      |     |
|  | /workflows/abc123   |      | /workflows/* -> https://my-app.com/wf |     |
|  | /workflows/def456   |      |                                       |     |
|  +---------------------+      +---------------------------------------+     |
|            |                               |                                |
|            +---------------+---------------+                                |
|                            | on matching append                             |
+----------------------------|-----------------------+------------------------+
                             |                       |
                             v POST                  v subscribe
+----------------------------+----+    +--------------------------------+
| WORKFLOW FUNCTION               |    | BROWSER CLIENT                 |
| (Vercel/Lambda/container/etc)   |    |                                |
|                                 |    | Stream -> TanStack DB -> UI    |
| +-----------------------------+ |    | Respond -> append to stream    |
| | Application: approveExpense | |    +--------------------------------+
| +-----------------------------+ |
| | Primitives: step.run, rpc   | |
| +-----------------------------+ |
| | SDK: replay, determinism    | |
| +-----------------------------+ |
|         |                       |
|         v read/append           |
+---------------------------------+
```

A workflow instance is identified by a stream URL. All workflow events — step completions, sleep timers, awaitables, responses — are appended to that stream. On external events, Durable Streams triggers the registered webhook; the workflow function replays from the stream, continues execution, and appends new events.

### TanStack Start Integration

For TanStack Start applications, workflows integrate directly as server functions with durable execution. The `createWorkflow` API mirrors `createServerFn`, so the mental model is familiar.

```tsx
// app/workflows/expense-approval.ts
import { createWorkflow } from '@tanstack/workflow'
import { z } from 'zod'

export const expenseApproval = createWorkflow({
  id: 'expense-approval',
  input: z.object({
    amount: z.number(),
    description: z.string(),
    submittedBy: z.string(),
  }),
})
  .handler(async ({ input, step, sleep, waitForEvent }) => {
    // Step 1: Validate expense
    const validated = await step.run('validate', async () => {
      return validateExpense(input)
    })

    // Step 2: If large expense, require manager approval
    if (input.amount > 1000) {
      const approval = await waitForEvent('manager-approval', {
        timeout: '48 hours',
      })

      if (!approval.approved) {
        return { status: 'rejected', reason: approval.reason }
      }
    }

    // Step 3: Process reimbursement
    const result = await step.run('process', async () => {
      return processReimbursement(validated)
    })

    return { status: 'approved', result }
  })
```

**Starting a workflow from a component:**

```tsx
// app/routes/expenses.tsx
import { expenseApproval } from '../workflows/expense-approval'

function ExpenseForm() {
  const startWorkflow = useServerFn(expenseApproval.start)

  const handleSubmit = async (data: ExpenseData) => {
    const { workflowId, streamUrl } = await startWorkflow({ data })
    // Navigate to workflow view
    navigate(`/expenses/${workflowId}`)
  }

  return <form onSubmit={handleSubmit}>...</form>
}
```

**Observing workflow state with TanStack DB:**

```tsx
// app/routes/expenses.$id.tsx
import { useWorkflow } from '@tanstack/workflow-client'

function ExpenseStatus() {
  const { workflowId } = useParams()
  const workflow = useWorkflow({ id: workflowId })

  // Reactive — updates as workflow progresses
  if (workflow.status === 'waiting') {
    return <ApprovalForm onSubmit={workflow.respond} />
  }

  if (workflow.status === 'completed') {
    return <ExpenseResult result={workflow.result} />
  }

  return <WorkflowProgress steps={workflow.steps} />
}
```

### TanStack AI Integration

TanStack AI provides framework-agnostic AI tooling with agentic flow support. Agentic AI applications — where an AI reasons through multi-step tasks, uses tools, and interacts with humans — need durable execution:

- **Human-in-the-loop approval**: Agent proposes an action, pauses for user confirmation
- **Tool confirmation**: Before executing a tool with side effects, wait for user approval
- **Long-running reasoning**: Multi-step agent tasks that may take hours or days
- **Graceful recovery**: If the server crashes mid-reasoning, resume from where you left off

```tsx
// app/workflows/ai-agent.ts
import { createWorkflow } from '@tanstack/workflow'
import { createChat } from '@tanstack/ai'

export const aiAgent = createWorkflow({ id: 'ai-agent' })
  .handler(async ({ input, step, waitForEvent }) => {
    const chat = createChat({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    })

    // Step 1: AI generates a plan
    const plan = await step.run('generate-plan', async () => {
      return chat.send({
        messages: [{ role: 'user', content: input.task }],
        systemPrompt: 'Generate a step-by-step plan for this task.',
      })
    })

    // Step 2: Wait for user to approve the plan
    const approval = await waitForEvent('plan-approval', {
      timeout: '24 hours',
      data: { plan: plan.content },  // Sent to client for display
    })

    if (!approval.approved) {
      return { status: 'cancelled', reason: approval.feedback }
    }

    // Step 3: Execute each step with tool calls
    for (const planStep of plan.steps) {
      const toolResult = await step.run(`execute-${planStep.id}`, async () => {
        return chat.send({
          messages: [{ role: 'user', content: `Execute: ${planStep.action}` }],
          tools: agentTools,
        })
      })

      // If tool has side effects, wait for confirmation
      if (toolResult.toolCall?.requiresConfirmation) {
        const confirm = await waitForEvent(`confirm-${planStep.id}`, {
          timeout: '1 hour',
          data: { tool: toolResult.toolCall },
        })

        if (!confirm.proceed) {
          continue  // Skip this step
        }
      }
    }

    return { status: 'completed', results: plan.steps }
  })
```

This enables building AI applications where:
- Users can review and approve AI-generated plans before execution
- Dangerous tool calls require explicit confirmation
- Long-running AI tasks survive server restarts
- The UI shows real-time progress through TanStack DB

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

#### The Awaitable Primitive

Under the hood, `waitForEvent()` and `rpc.call()` are specializations of a lower-level construct: the **awaitable**. This mirrors patterns in Restate (durable promises), Trigger.dev (waitpoint tokens), and Vercel WDK (hooks).

```typescript
// Low-level awaitable API (conceptual)
const awaitable = workflow.awaitable.create({
  id: "approval-request",
  schema: ApprovalSchema,        // optional type validation
  timeout: "48 hours",
  audience: { user: "manager@example.com" }  // who can respond
});

// Workflow suspends until resolved
const result = await awaitable.wait();
```

Then:
- `waitForEvent(id, opts)` = create awaitable + wait for matching event
- `rpc.call(method, args)` = create awaitable + publish request object with method signature

This unification clarifies semantics for timeout behavior, late responses, cancellation, and multi-tab conflicts — all awaitables share the same lifecycle.

### RPC-Style Client Interaction

Beyond generic `waitForEvent`, workflows can define RPC methods that clients call. The RPC system is based on Cloudflare's Cap'n Proto-inspired Workers RPC and will be developed as a standalone project — it's useful outside of workflows for any server-client communication over durable streams. However, it integrates seamlessly into workflows, similar to how the State Protocol is a standalone spec that workflows build on.

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

For loops, use explicit IDs that include a stable identifier from the item:

```typescript
for (const item of items) {
  // Good: ID is stable even if items array changes between replays
  await step.run(`process-item-${item.id}`, () => processItem(item));
}
```

If items lack stable identifiers, the collection itself must be deterministic — fetched inside a prior `step.run()` so the same items appear on replay:

```typescript
const items = await step.run("fetch-items", () => db.items.list());
for (const item of items) {
  // Safe: items is replayed from step result, so order is stable
  await step.run(`process-item-${item.id}`, () => processItem(item));
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

### Execution Semantics

The workflow engine provides **at-least-once** execution semantics for steps:

- Steps may be executed multiple times if the workflow crashes after execution but before recording completion
- Step functions must be idempotent — producing the same result when called multiple times with the same inputs
- For operations that cannot be made idempotent (e.g., sending emails, charging credit cards), use external idempotency keys or check-then-act patterns within the step

This matches the semantics of Temporal, Inngest, and other durable execution engines. Exactly-once semantics would require distributed transactions with external systems, which is impractical for most use cases.

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

### Workflow Schema

Workflow state is persisted using the State Protocol's insert/update/delete ChangeEvents. The workflow engine defines entity types and their state machines.

**Entity types** (high-level, formal spec TBD):

```typescript
// Workflow instance state
type: "workflow"
key: workflowId
value: {
  status: "running" | "sleeping" | "waiting" | "completed" | "failed"
  result?: any
  error?: Error
  sleepUntil?: timestamp
  waitingFor?: { type: string, timeout?: timestamp }
}

// Step execution records
type: "step"
key: `${workflowId}:${stepId}:${counter}`
value: {
  status: "running" | "completed" | "failed"
  result?: any
  error?: Error
  attempt: number
}

// Pending RPC calls
type: "rpc"
key: `${workflowId}:${rpcId}`
value: {
  method: string
  args: any
  response?: any
  respondedAt?: timestamp
}
```

**State machines:**

- Workflow: `running → sleeping → running → waiting → running → completed|failed`
- Step: `running → completed|failed` (with retries: `failed → running → ...`)
- RPC: created (pending) → updated with response → deleted on workflow completion

The formal schema specification will be developed as a separate document, building on STATE-PROTOCOL.md.

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

### Stream Views

A key design constraint: Durable Streams' power comes from CDN caching, shared URLs, and request collapsing. But if different viewers need to see different subsets of events (for security or relevance), a single stream URL breaks down.

**Solution: separate internal and public streams**

```
stream://workflow/<id>/internal    # Full fidelity: all step results, traces, internal state
stream://workflow/<id>/view/client # Public: only entities/fields this audience can see
stream://workflow/<id>/view/admin  # Admin: more visibility than client, less than internal
```

Each view is a **State Protocol projection** of the canonical internal stream:

- Views have their own offset sequences (clients can resume cleanly)
- Views preserve CDN cacheability (all clients watching the same view share the cache)
- Visibility rules are defined at the schema level, not ad-hoc filtering

This addresses the "visibility boundaries" concern: the workflow can include sensitive step results in the internal stream, while the client view only exposes pending awaitables and workflow status.

**Capability-based access**: Following Cloudflare's Workers RPC security model (object-capability based), stream URLs themselves can be capabilities. Possession of the URL = authority to read that view. The workflow can issue scoped, unguessable URLs for specific audiences or one-shot responses.

### Runtime Model: Webhook-Based Execution

A key design goal is **runtime-agnostic** — workflow code should run anywhere. Rather than requiring a specific platform or long-running process, Durable Streams uses webhooks to trigger workflow execution.

**Registration:**

```typescript
// Register a workflow handler for a stream pattern
await durableStreams.webhooks.register({
  pattern: "/workflows/expense-approval/*",
  url: "https://my-app.com/api/workflows/expense-approval",
  filter: {
    // Only trigger on external events, not internal step completions
    eventTypes: ["awaitable-response", "external-event", "timer-expired"]
  },
  concurrency: "per-stream-serial"  // One execution at a time per workflow
});
```

**Execution flow:**

```
1. External event appends to stream (e.g., user responds to awaitable)
          │
          ▼
2. Durable Streams matches stream against registered webhooks
          │
          ▼
3. POST to webhook URL with stream ID and new events
          │
          ▼
4. Workflow function:
   - Reads stream from offset 0 (or checkpoint)
   - Replays to rebuild state
   - Continues execution from where it left off
   - Appends new events (step results, new awaitables, etc.)
   - Returns (suspends until next external event)
```

**Payload delivery:**

By default, the webhook POST includes the **full stream contents**. This simplifies the workflow function — it receives everything it needs in one request, no additional fetches required. For most workflows (even 1-2MB of events), this is fine.

```typescript
// Webhook payload
{
  stream: "/workflows/expense-approval/abc123",
  events: [...],  // Full stream contents
  trigger: { type: "awaitable-response", offset: 42 }
}
```

For workflows with large event histories, registration can opt into **incremental delivery**:

```typescript
await durableStreams.webhooks.register({
  pattern: "/workflows/data-pipeline/*",
  url: "https://my-app.com/api/workflows/data-pipeline",
  delivery: "incremental"  // Only new events; function fetches history if needed
});
```

With incremental delivery, the function receives only the triggering event(s) plus a stream URL. The SDK handles fetching and replaying history transparently.

**Why webhooks:**

- **Host anywhere**: Vercel, Cloudflare, AWS Lambda, containers, VMs, Raspberry Pi
- **Serverless-friendly**: Function only runs when there's work to do
- **No polling overhead**: Push-based means immediate wake-up
- **Protocol-first**: Durable Streams doesn't need to understand specific runtimes

**Concurrency control:**

Webhooks are delivered serially per stream (`per-stream-serial`). This ensures only one execution runs at a time for a given workflow instance, preventing race conditions during replay.

**Initial trigger:**

Workflow creation appends an initial event to a new stream, which triggers the first webhook invocation. The workflow runs until it suspends (sleep, awaitable, or completion).

### Packages

Initial packages:

- **`@tanstack/workflow`** — Server SDK for defining workflow functions
- **`@tanstack/workflow-client`** — React/Solid hooks for observing and interacting with workflows (built on TanStack DB)

The underlying protocol is language-agnostic. Future SDKs for Python, Go, and PHP would enable cross-language workflows (e.g., Python workflow with React client), following the same pattern as TanStack AI's multi-language support.

### Open Questions

Areas requiring prototyping to resolve:

1. **Determinism detection**: What specific patterns should dev mode detect? How aggressive should runtime enforcement be?

2. **RPC type safety**: How do we ensure type safety between server RPC definitions and client rendering? Schema generation?

3. **Concurrent steps**: Should there be a `step.parallel()` primitive, or is `Promise.all()` with multiple `step.run()` sufficient? If concurrent, what is the deterministic ordering of commands (sort by step ID? creation order?)?

4. **Workflow versioning**: When workflow code changes while instances are in-flight, how do running workflows handle the transition? Temporal uses explicit versioning APIs; Inngest uses function version hashes. This is critical for production but may be out of scope for initial prototype.

5. **Data retention and compaction**: Workflow streams grow unbounded as steps complete. How do we handle:
   - Archiving completed workflows
   - Compacting step history while preserving replay capability
   - Configurable retention policies per workflow type

6. **Awaitable lifecycle**: The unified awaitable primitive needs precise semantics:
   - **ID generation**: Must IDs be deterministic, or can the workflow generate them freely?
   - **Timeout behavior**: Throw (Cloudflare) vs return null (Inngest) vs tagged result type?
   - **Late responses**: What happens if a response arrives after timeout? After workflow completion?
   - **Cancellation**: Can the workflow cancel a pending awaitable?
   - **Multi-tab conflict**: If the targeted user has multiple tabs, first-write-wins? Claim-then-respond?
   - **Idempotency**: Can the same awaitable be responded to multiple times?

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


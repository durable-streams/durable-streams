# @durable-streams/agent-client-protocol Implementation Plan (XState)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript library that bridges ACP coding agents to a remote durable stream, enabling durable, multi-device, multi-user coding sessions.

**Architecture:** A thin bridge (Node-only) spawns an ACP agent subprocess, persists ACP traffic to a durable stream, and relays stream traffic back to the agent. A separate browser-safe client appends prompts, responses, and cancels to the same stream. Replay uses synthesized history with path rewriting. Coordination is handled by an explicit XState machine.

**Tech Stack:** TypeScript, `@durable-streams/client`, `xstate`, vitest, tsdown, Node.js `child_process`

**Spec:** `docs/superpowers/specs/2026-03-31-durable-streams-acp-bridge-design.md`

---

## Core constraints

These are the design rules the implementation must preserve:

- The bridge is a **pure relay**. It does not execute `fs/*`, `terminal/*`, or permission policy locally.
- All ACP writes that matter for replay and multi-device consistency must flow through the durable stream.
- The bridge may forward a JSON-RPC response to the agent **only after** that response has been observed on the stream.
- The bridge must not advertise ACP `clientCapabilities` such as `fs` or `terminal`.
- Prompt turns must be serialized. A second prompt cannot be sent to the agent until the current prompt turn completes.
- Agent-initiated request ids must be tracked so duplicate client responses are dropped and `session/cancel` can generate cancelled outcomes for pending requests.
- Resume must tail from the offset after consumed history: `historyResponse.offset`, never `head()`.

---

## Why XState

The previous plan kept most protocol choreography in ad hoc flags and callbacks. That made the edge cases hard to reason about:

- replay vs live tail startup
- prompt queueing while a turn is active
- pending request tracking
- duplicate client responses
- cancel handling for pending requests
- boot / ready / close sequencing

XState gives us:

- explicit states
- explicit events
- guarded transitions
- testable coordination logic without live network or child-process IO
- a small `bridge.ts` wrapper that only wires real IO into the machine

---

## State machine

The machine owns lifecycle and sequencing. Real IO lives in injected dependencies and thin wiring code.

### Top-level states

- `booting`
  - load history from the stream
  - capture `resumeOffset`
- `initializing`
  - send ACP `initialize`
  - send ACP `session/new`
- `replaying`
  - if history exists, send a replay prompt
  - append `session_resumed` control event to the stream
- `live`
  - steady-state relay mode
  - nested prompt-turn states
- `closing`
  - stop live tail
  - append `session_ended`
  - kill agent
- `failed`
  - terminal error state for bridge startup failures

### Nested `live` states

- `idle`
  - no prompt in flight
  - if queue has a prompt, transition to `turnActive`
- `turnActive`
  - one ACP `session/prompt` is in flight
  - additional prompts are queued
  - on completion, return to `idle`

### Key events

- `AGENT_NOTIFICATION`
- `AGENT_RESPONSE`
- `AGENT_REQUEST`
- `STREAM_PROMPT`
- `STREAM_RESPONSE`
- `STREAM_CANCEL`
- `CLOSE`

### Machine invariants

- `resumeOffset` is assigned exactly once from consumed history.
- Every `AGENT_REQUEST` id is added to `pendingAgentRequestIds`.
- Only the first `STREAM_RESPONSE` for a pending id is forwarded to the agent.
- `STREAM_CANCEL` appends cancelled response envelopes to the stream for all pending ids, then relays `session/cancel`.
- Pending request ids are cleared only when the matching stream responses are observed and forwarded.
- `AGENT_NOTIFICATION`, `AGENT_RESPONSE`, and `AGENT_REQUEST` are always appended to the stream.

---

## File structure

```text
packages/agent-client-protocol/
  package.json
  tsdown.config.ts
  tsconfig.json
  src/
    index.ts        — exports createAgentStream + types
    client.ts       — exports createStreamClient (browser-safe)
    types.ts        — shared ACP / stream / machine types
    replay.ts       — build replay text + path rewriting
    agent.ts        — ACP subprocess transport + JSON-RPC parsing
    machine.ts      — XState bridge machine
    bridge.ts       — real wiring: stream + agent + actor lifecycle
  test/
    replay.test.ts
    agent.test.ts
    machine.test.ts
    bridge.test.ts
    client.test.ts
```

---

## Task 1: Project scaffold

**Files:**

- Create: `packages/agent-client-protocol/package.json`
- Create: `packages/agent-client-protocol/tsdown.config.ts`
- Create: `packages/agent-client-protocol/tsconfig.json`
- Create: `packages/agent-client-protocol/src/index.ts`
- Create: `packages/agent-client-protocol/src/client.ts`
- Create: `packages/agent-client-protocol/src/types.ts`
- Create: `packages/agent-client-protocol/src/replay.ts`
- Create: `packages/agent-client-protocol/src/agent.ts`
- Create: `packages/agent-client-protocol/src/machine.ts`
- Create: `packages/agent-client-protocol/src/bridge.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

Use the existing package conventions in this repo, but add `xstate` as a runtime dependency:

```json
{
  "name": "@durable-streams/agent-client-protocol",
  "version": "0.1.0",
  "description": "Bridge ACP coding agents to a remote durable stream",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./client": {
      "import": {
        "types": "./dist/client.d.ts",
        "default": "./dist/client.js"
      },
      "require": {
        "types": "./dist/client.d.cts",
        "default": "./dist/client.cjs"
      }
    },
    "./package.json": "./package.json"
  },
  "sideEffects": false,
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@durable-streams/client": "workspace:*",
    "xstate": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create `tsdown.config.ts`**

```typescript
import type { Options } from "tsdown"

const config: Options = {
  entry: ["src/index.ts", "src/client.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
}

export default config
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*", "test/**/*", "*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Add a Vitest project**

Add the alias and test project in `vitest.config.ts`:

```typescript
"@durable-streams/agent-client-protocol": path.resolve(
  __dirname,
  "./packages/agent-client-protocol/src"
),
```

```typescript
defineProject({
  test: {
    name: "agent-client-protocol",
    include: ["packages/agent-client-protocol/test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
  resolve: { alias },
}),
```

- [ ] **Step 5: Create placeholder files and verify install**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm install
```

Expected: clean install, including `xstate`.

---

## Task 2: Shared types

**Files:**

- Create: `packages/agent-client-protocol/src/types.ts`

- [ ] **Step 1: Write shared stream, JSON-RPC, and machine types**

The types module should define:

- stream message envelopes
- JSON-RPC request / response / error shapes
- client API types
- XState machine context, input, events, and dependency contracts

Target shape:

```typescript
export interface UserIdentity {
  name: string
  email: string
}

export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: JsonRpcErrorShape
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification

export interface AgentEvent {
  direction: "agent"
  timestamp: number
  payload: JsonRpcMessage
}

export interface UserEvent {
  direction: "user"
  timestamp: number
  user: UserIdentity
  payload: JsonRpcRequest | JsonRpcResponse
}

export interface ControlEvent {
  direction: "agent"
  timestamp: number
  type: "session_resumed" | "session_ended"
}

export type StreamMessage = AgentEvent | UserEvent | ControlEvent

export interface ReplayOptions {
  rewritePaths?: Record<string, string>
}

export interface StreamOptions {
  url: string
  contentType?: string
  headers?: Record<string, string | (() => string | Promise<string>)>
}

export interface AgentStreamOptions {
  agent: string | { command: string; args?: string[] }
  streamOptions: StreamOptions
  cwd: string
  mcpServers?: unknown[]
  replayOptions?: ReplayOptions
}

export interface AgentStreamSession {
  sessionId: string
  close(): Promise<void>
}

export type ClientResponseInput =
  | { result: unknown }
  | { error: JsonRpcErrorShape }

export interface StreamClientOptions {
  streamOptions: StreamOptions
  user: UserIdentity
}

export interface StreamClient {
  prompt(text: string): Promise<void>
  respond(
    requestId: number | string,
    response: ClientResponseInput
  ): Promise<void>
  cancel(): Promise<void>
  close(): Promise<void>
}

export interface PendingPrompt {
  params: Record<string, unknown>
}

export interface BridgeMachineContext {
  history: StreamMessage[]
  replayText: string
  resumeOffset?: string
  sessionId?: string
  promptQueue: PendingPrompt[]
  currentPrompt?: PendingPrompt
  pendingAgentRequestIds: Set<number | string>
  lastError?: Error
}

export type BridgeMachineEvent =
  | { type: "AGENT_NOTIFICATION"; method: string; params: unknown }
  | { type: "AGENT_RESPONSE"; response: JsonRpcResponse }
  | {
      type: "AGENT_REQUEST"
      id: number | string
      method: string
      params: unknown
    }
  | { type: "STREAM_PROMPT"; params: Record<string, unknown> }
  | {
      type: "STREAM_RESPONSE"
      id: number | string
      result?: unknown
      error?: JsonRpcErrorShape
    }
  | { type: "STREAM_CANCEL"; user: UserIdentity }
  | { type: "CLOSE" }

export interface BridgeMachineInput {
  cwd: string
  mcpServers: unknown[]
  replayOptions: ReplayOptions
  deps: BridgeMachineDeps
}

export interface BridgeMachineDeps {
  loadHistory(): Promise<{ history: StreamMessage[]; resumeOffset: string }>
  initializeSession(
    cwd: string,
    mcpServers: unknown[]
  ): Promise<{ sessionId: string }>
  sendAgentPrompt(
    sessionId: string,
    params: Record<string, unknown>
  ): Promise<JsonRpcResponse>
  sendAgentCancel(sessionId: string): void
  sendAgentResponse(response: JsonRpcResponse): void
  appendStreamMessage(message: StreamMessage): Promise<void>
  killAgent(): void
  now(): number
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol typecheck
```

Expected: no errors.

---

## Task 3: Replay module

**Files:**

- Create: `packages/agent-client-protocol/src/replay.ts`
- Create: `packages/agent-client-protocol/test/replay.test.ts`

- [ ] **Step 1: Keep the full-fidelity replay approach**

The replay module should stay intentionally simple:

- serialize each non-control `StreamMessage` as a JSON line
- preserve both user and agent envelopes
- rewrite paths with string replacement
- do **not** compact or truncate by default

Implementation target:

```typescript
import type { ReplayOptions, StreamMessage } from "./types.js"

const REPLAY_PREFIX =
  "Previous session history is replayed below as JSON-RPC envelopes. Use it as context before responding to the latest user prompt.\n"

export function rewritePaths(
  text: string,
  pathMap: Record<string, string>
): string {
  let result = text
  for (const [from, to] of Object.entries(pathMap)) {
    result = result.replaceAll(from, to)
  }
  return result
}

export function buildReplayText(
  messages: StreamMessage[],
  options: ReplayOptions = {}
): string {
  if (messages.length === 0) return ""

  let text = REPLAY_PREFIX
  for (const msg of messages) {
    if ("type" in msg) continue
    text +=
      JSON.stringify({
        direction: msg.direction,
        timestamp: msg.timestamp,
        payload: msg.payload,
      }) + "\n"
  }

  return options.rewritePaths ? rewritePaths(text, options.rewritePaths) : text
}
```

- [ ] **Step 2: Keep the replay tests focused**

The tests must verify:

- path rewriting works
- control events are excluded
- user and agent envelopes are preserved
- no tool-call filtering happens
- empty history returns `""`

---

## Task 4: Agent transport module

**Files:**

- Create: `packages/agent-client-protocol/src/agent.ts`
- Create: `packages/agent-client-protocol/test/agent.test.ts`

- [ ] **Step 1: Keep `agent.ts` as a transport, not a workflow engine**

Responsibilities:

- resolve known agents (`claude`, `codex`)
- spawn child process
- parse JSON-RPC lines from stdout
- classify stdout messages as:
  - request: `id + method`
  - notification: `method` only
  - response: `id` only
- expose imperative methods:
  - `sendRequest(...)`
  - `sendNotification(...)`
  - `sendResponse(...)`

Target public surface:

```typescript
export interface AgentProcess {
  process: ChildProcess
  sendRequest(method: string, params?: unknown): Promise<JsonRpcResponse>
  sendNotification(method: string, params?: unknown): void
  sendResponse(response: JsonRpcResponse): void
  onNotification(handler: (method: string, params: unknown) => void): void
  onRequest(
    handler: (id: number | string, method: string, params: unknown) => void
  ): void
  onResponse(handler: (response: JsonRpcResponse) => void): void
  kill(): void
}
```

- [ ] **Step 2: Add one more parser test than the old plan**

In addition to `resolveAgent` tests, add a parser test that confirms:

- a stdout message with both `id` and `method` is treated as a request
- not as a response

- [ ] **Step 3: Keep `initializeAgent(...)` thin**

The initializer should only:

- send ACP `initialize`
- send ACP `session/new`
- return `{ sessionId }`

It should **not** advertise ACP `clientCapabilities`.

---

## Task 5: Write machine tests first

**Files:**

- Create: `packages/agent-client-protocol/test/machine.test.ts`

- [ ] **Step 1: Write failing tests for the state machine**

These tests are the reason for switching to XState. They should verify protocol choreography directly, with mocked deps and no real network or child process.

Scenarios to cover:

1. `booting -> initializing -> live.idle` when history is empty
2. existing history sends replay prompt before entering steady-state prompt processing
3. `resumeOffset` is whatever `loadHistory()` returns, not a separate `head()` call
4. prompts are serialized:
   - first `STREAM_PROMPT` sends immediately
   - second `STREAM_PROMPT` queues while turn is active
   - queued prompt sends only after the first prompt completes
5. `AGENT_NOTIFICATION` appends to stream
6. `AGENT_RESPONSE` appends to stream
7. `AGENT_REQUEST` appends to stream and adds id to `pendingAgentRequestIds`
8. first `STREAM_RESPONSE` for a pending id forwards to the agent and clears the id
9. duplicate `STREAM_RESPONSE` for the same id is ignored
10. `STREAM_CANCEL`:
    - appends cancelled response envelopes to the stream for all pending ids
    - relays `session/cancel` to the agent

- [ ] **Step 2: Use mocked deps, not fake child processes**

The machine tests should instantiate the actor with mocked `BridgeMachineDeps`, for example:

```typescript
const deps: BridgeMachineDeps = {
  loadHistory: vi.fn(),
  initializeSession: vi.fn(),
  sendAgentPrompt: vi.fn(),
  sendAgentCancel: vi.fn(),
  sendAgentResponse: vi.fn(),
  appendStreamMessage: vi.fn(),
  killAgent: vi.fn(),
  now: vi.fn(() => 1000),
}
```

---

## Task 6: Implement `machine.ts`

**Files:**

- Create: `packages/agent-client-protocol/src/machine.ts`

- [ ] **Step 1: Build the machine with XState v5**

Use:

- `setup(...)`
- `assign(...)`
- `fromPromise(...)`
- `createMachine(...)`

The machine should be created from `BridgeMachineInput` and injected `BridgeMachineDeps`.

- [ ] **Step 2: Implement the machine structure**

Target shape:

```typescript
import { assign, fromPromise, setup } from "xstate"
import { buildReplayText } from "./replay.js"
import type {
  BridgeMachineContext,
  BridgeMachineEvent,
  BridgeMachineInput,
  JsonRpcResponse,
  StreamMessage,
  UserEvent,
} from "./types.js"

function makeCancelledResponse(
  id: number | string,
  user: { name: string; email: string },
  now: number
): UserEvent {
  return {
    direction: "user",
    timestamp: now,
    user,
    payload: {
      jsonrpc: "2.0",
      id,
      result: { outcome: { outcome: "cancelled" } },
    },
  }
}

export function createBridgeMachine(machineInput: BridgeMachineInput) {
  const { deps, cwd, mcpServers, replayOptions } = machineInput

  return setup({
    types: {
      context: {} as BridgeMachineContext,
      events: {} as BridgeMachineEvent,
    },
    actors: {
      loadHistory: fromPromise(async () => deps.loadHistory()),
      initializeSession: fromPromise(async () =>
        deps.initializeSession(cwd, mcpServers)
      ),
      sendReplayPrompt: fromPromise(async ({ context }) => {
        if (!context.sessionId || !context.replayText) return
        const pending = deps.sendAgentPrompt(context.sessionId, {
          prompt: [{ type: "text", text: context.replayText }],
        })
        await deps.appendStreamMessage({
          direction: "agent",
          timestamp: deps.now(),
          type: "session_resumed",
        })
        return pending
      }),
      sendCurrentPrompt: fromPromise(async ({ context }) => {
        if (!context.sessionId || !context.currentPrompt) return
        return deps.sendAgentPrompt(
          context.sessionId,
          context.currentPrompt.params
        )
      }),
    },
    guards: {
      hasReplay: ({ context }) => context.replayText.length > 0,
      hasQueuedPrompt: ({ context }) => context.promptQueue.length > 0,
    },
    actions: {
      setBootstrapData: assign(({ event, context }) => {
        if (!("output" in event) || !event.output) return {}
        const history = event.output.history as StreamMessage[]
        const replayText = buildReplayText(history, replayOptions)
        return {
          ...context,
          history,
          replayText,
          resumeOffset: event.output.resumeOffset as string,
        }
      }),
      enqueuePrompt: assign(({ context, event }) => {
        if (event.type !== "STREAM_PROMPT") return {}
        return {
          ...context,
          promptQueue: [...context.promptQueue, { params: event.params }],
        }
      }),
      startNextPrompt: assign(({ context }) => {
        const [currentPrompt, ...rest] = context.promptQueue
        return {
          ...context,
          currentPrompt,
          promptQueue: rest,
        }
      }),
      clearCurrentPrompt: assign(({ context }) => ({
        ...context,
        currentPrompt: undefined,
      })),
      appendAgentNotification: ({ event }) => {
        if (event.type !== "AGENT_NOTIFICATION") return
        void deps.appendStreamMessage({
          direction: "agent",
          timestamp: deps.now(),
          payload: {
            jsonrpc: "2.0",
            method: event.method,
            params: event.params,
          },
        })
      },
      appendAgentResponse: ({ event }) => {
        if (event.type !== "AGENT_RESPONSE") return
        void deps.appendStreamMessage({
          direction: "agent",
          timestamp: deps.now(),
          payload: event.response,
        })
      },
      appendAgentRequest: assign(({ context, event }) => {
        if (event.type !== "AGENT_REQUEST") return {}
        void deps.appendStreamMessage({
          direction: "agent",
          timestamp: deps.now(),
          payload: {
            jsonrpc: "2.0",
            id: event.id,
            method: event.method,
            params: event.params,
          },
        })
        const next = new Set(context.pendingAgentRequestIds)
        next.add(event.id)
        return { ...context, pendingAgentRequestIds: next }
      }),
      forwardStreamResponseIfPending: assign(({ context, event }) => {
        if (event.type !== "STREAM_RESPONSE") return {}
        if (!context.pendingAgentRequestIds.has(event.id)) return {}
        const next = new Set(context.pendingAgentRequestIds)
        next.delete(event.id)
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: event.id,
          ...(event.error ? { error: event.error } : { result: event.result }),
        }
        deps.sendAgentResponse(response)
        return { ...context, pendingAgentRequestIds: next }
      }),
      appendCancelledResponsesForPending: ({ context, event }) => {
        if (event.type !== "STREAM_CANCEL") return
        for (const id of context.pendingAgentRequestIds) {
          void deps.appendStreamMessage(
            makeCancelledResponse(id, event.user, deps.now())
          )
        }
      },
      relayCancel: ({ context }) => {
        if (!context.sessionId) return
        deps.sendAgentCancel(context.sessionId)
      },
      setSessionId: assign(({ context, event }) => {
        if (!("output" in event) || !event.output?.sessionId) return {}
        return { ...context, sessionId: event.output.sessionId as string }
      }),
      setError: assign(({ context, event }) => ({
        ...context,
        lastError: new Error(
          String(("error" in event ? event.error : event) ?? "unknown")
        ),
      })),
      appendSessionEnded: () => {
        void deps.appendStreamMessage({
          direction: "agent",
          timestamp: deps.now(),
          type: "session_ended",
        })
      },
      killAgent: () => {
        deps.killAgent()
      },
    },
  }).createMachine({
    id: "bridge",
    initial: "booting",
    context: {
      history: [],
      replayText: "",
      resumeOffset: undefined,
      sessionId: undefined,
      promptQueue: [],
      currentPrompt: undefined,
      pendingAgentRequestIds: new Set<number | string>(),
      lastError: undefined,
    },
    on: {
      AGENT_NOTIFICATION: { actions: "appendAgentNotification" },
      AGENT_RESPONSE: { actions: "appendAgentResponse" },
      AGENT_REQUEST: { actions: "appendAgentRequest" },
      STREAM_RESPONSE: { actions: "forwardStreamResponseIfPending" },
      CLOSE: { target: ".closing" },
    },
    states: {
      booting: {
        invoke: {
          src: "loadHistory",
          onDone: {
            actions: "setBootstrapData",
            target: "initializing",
          },
          onError: {
            actions: "setError",
            target: "failed",
          },
        },
      },
      initializing: {
        invoke: {
          src: "initializeSession",
          onDone: [
            {
              actions: "setSessionId",
              target: "replaying",
              guard: "hasReplay",
            },
            {
              actions: "setSessionId",
              target: "live",
            },
          ],
          onError: {
            actions: "setError",
            target: "failed",
          },
        },
      },
      replaying: {
        on: {
          STREAM_PROMPT: { actions: "enqueuePrompt" },
          STREAM_CANCEL: {
            actions: ["appendCancelledResponsesForPending", "relayCancel"],
          },
        },
        invoke: {
          src: "sendReplayPrompt",
          onDone: { target: "live" },
          onError: {
            actions: "setError",
            target: "failed",
          },
        },
      },
      live: {
        initial: "idle",
        states: {
          idle: {
            always: {
              guard: "hasQueuedPrompt",
              actions: "startNextPrompt",
              target: "turnActive",
            },
            on: {
              STREAM_PROMPT: { actions: "enqueuePrompt" },
            },
          },
          turnActive: {
            on: {
              STREAM_PROMPT: { actions: "enqueuePrompt" },
            },
            invoke: {
              src: "sendCurrentPrompt",
              onDone: {
                actions: "clearCurrentPrompt",
                target: "idle",
              },
              onError: {
                actions: "setError",
                target: "#bridge.failed",
              },
            },
          },
        },
        on: {
          STREAM_CANCEL: {
            actions: ["appendCancelledResponsesForPending", "relayCancel"],
          },
        },
      },
      closing: {
        entry: ["appendSessionEnded", "killAgent"],
        type: "final",
      },
      failed: {
        type: "final",
      },
    },
  })
}
```

- [ ] **Step 3: Typecheck and run machine tests**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol -t machine
```

Expected: machine tests pass after implementation.

---

## Task 7: Implement `bridge.ts` as thin wiring

**Files:**

- Create: `packages/agent-client-protocol/src/bridge.ts`
- Create: `packages/agent-client-protocol/test/bridge.test.ts`

- [ ] **Step 1: Keep `bridge.ts` small**

`bridge.ts` should do only real IO wiring:

- create or connect the stream
- create the agent process
- define real `BridgeMachineDeps`
- register agent listeners **before** actor start
- start the XState actor
- start the live tail once `resumeOffset` is available
- map live stream messages into machine events
- expose `close()`

- [ ] **Step 2: Implement the real deps**

The key dep implementations should look like:

```typescript
const deps: BridgeMachineDeps = {
  async loadHistory() {
    const historyResponse = await stream.stream<StreamMessage>({ json: true })
    const history = await historyResponse.json()
    return {
      history,
      resumeOffset: historyResponse.offset,
    }
  },

  initializeSession(currentCwd, currentMcpServers) {
    return initializeAgent(agent, currentCwd, currentMcpServers)
  },

  sendAgentPrompt(sessionId, params) {
    return agent.sendRequest("session/prompt", { ...params, sessionId })
  },

  sendAgentCancel(sessionId) {
    agent.sendNotification("session/cancel", { sessionId })
  },

  sendAgentResponse(response) {
    agent.sendResponse(response)
  },

  appendStreamMessage(message) {
    return stream.append(JSON.stringify(message))
  },

  killAgent() {
    agent.kill()
  },

  now() {
    return Date.now()
  },
}
```

- [ ] **Step 3: Start live tail from machine context**

Register a machine subscription that starts the live tail exactly once when `resumeOffset` becomes available:

```typescript
let stopTail: (() => void) | undefined

actor.subscribe((snapshot) => {
  if (!stopTail && snapshot.context.resumeOffset) {
    const abortController = new AbortController()
    stopTail = () => abortController.abort()

    void (async () => {
      const liveStream = await stream.stream<StreamMessage>({
        offset: snapshot.context.resumeOffset,
        live: "sse",
        json: true,
        signal: abortController.signal,
      })

      for await (const item of liveStream.jsonStream()) {
        if (item.direction !== "user") continue

        const payload = item.payload as Record<string, unknown>
        const method = payload.method as string | undefined
        const id = payload.id as number | string | undefined

        if (method === "session/prompt") {
          actor.send({
            type: "STREAM_PROMPT",
            params: (payload.params as Record<string, unknown>) ?? {},
          })
        } else if (method === "session/cancel") {
          actor.send({ type: "STREAM_CANCEL", user: item.user })
        } else if (id != null && !method) {
          actor.send({
            type: "STREAM_RESPONSE",
            id,
            result: payload.result,
            error: payload.error as JsonRpcErrorShape | undefined,
          })
        }
      }
    })()
  }
})
```

- [ ] **Step 4: Register agent listeners before actor start**

This prevents missing replay-turn updates:

```typescript
agent.onNotification((method, params) => {
  actor.send({ type: "AGENT_NOTIFICATION", method, params })
})

agent.onResponse((response) => {
  actor.send({ type: "AGENT_RESPONSE", response })
})

agent.onRequest((id, method, params) => {
  actor.send({ type: "AGENT_REQUEST", id, method, params })
})
```

- [ ] **Step 5: Add a minimal `bridge.test.ts`**

Test only the wiring-specific invariants:

- listeners are registered before actor start
- history tailing uses `historyResponse.offset`
- user response messages with `result` and `error` are both mapped into `STREAM_RESPONSE`

---

## Task 8: Client module

**Files:**

- Create: `packages/agent-client-protocol/src/client.ts`
- Create: `packages/agent-client-protocol/test/client.test.ts`

- [ ] **Step 1: Keep the client browser-safe and stream-only**

The client should only append stream messages:

- `prompt(...)`
- `respond(...)`
- `cancel()`

Implementation target:

```typescript
import { DurableStream } from "@durable-streams/client"
import type {
  ClientResponseInput,
  JsonRpcResponse,
  StreamClient,
  StreamClientOptions,
  UserEvent,
} from "./types.js"

export function createStreamClient(options: StreamClientOptions): StreamClient {
  const { streamOptions, user } = options
  const stream = new DurableStream({
    url: streamOptions.url,
    contentType: streamOptions.contentType ?? "application/json",
    headers: streamOptions.headers,
  })

  let nextId = 1

  return {
    async prompt(text: string): Promise<void> {
      const message: UserEvent = {
        direction: "user",
        timestamp: Date.now(),
        user,
        payload: {
          jsonrpc: "2.0",
          id: nextId++,
          method: "session/prompt",
          params: {
            prompt: [{ type: "text", text }],
          },
        },
      }
      await stream.append(JSON.stringify(message))
    },

    async respond(
      requestId: number | string,
      response: ClientResponseInput
    ): Promise<void> {
      const payload: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: requestId,
        ...response,
      }

      const message: UserEvent = {
        direction: "user",
        timestamp: Date.now(),
        user,
        payload,
      }

      await stream.append(JSON.stringify(message))
    },

    async cancel(): Promise<void> {
      const message: UserEvent = {
        direction: "user",
        timestamp: Date.now(),
        user,
        payload: {
          jsonrpc: "2.0",
          method: "session/cancel",
        },
      }
      await stream.append(JSON.stringify(message))
    },

    async close(): Promise<void> {
      // DurableStream is a cold handle; nothing to clean up.
    },
  }
}
```

- [ ] **Step 2: Update tests**

Tests must verify:

- prompt appends a `session/prompt` request
- respond appends a JSON-RPC response with `result`
- respond appends a JSON-RPC response with `error`
- cancel appends `session/cancel`
- content type defaults to `application/json`

---

## Task 9: Entrypoints, build, and verification

**Files:**

- Create: `packages/agent-client-protocol/src/index.ts`

- [ ] **Step 1: Export the public API**

`src/index.ts` should export:

```typescript
export { createAgentStream } from "./bridge.js"
export type { AgentStreamSession } from "./types.js"
export { createBridgeMachine } from "./machine.js"
export type {
  AgentStreamOptions,
  StreamClientOptions,
  StreamClient,
  StreamMessage,
  AgentEvent,
  UserEvent,
  ControlEvent,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcErrorShape,
  ClientResponseInput,
  BridgeMachineContext,
  BridgeMachineEvent,
  BridgeMachineInput,
  BridgeMachineDeps,
  ReplayOptions,
  StreamOptions,
} from "./types.js"
```

- [ ] **Step 2: Run the full verification sequence**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol typecheck
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol build
ls -la /Users/kylemathews/programs/durable-streams/packages/agent-client-protocol/dist/
```

Expected:

- typecheck passes
- replay / agent / machine / bridge / client tests pass
- build emits `index.*` and `client.*`

---

## Implementation notes

- The bridge should remain around “wiring code + actor lifecycle”, not another home-grown state machine.
- The machine should own sequencing, not `bridge.ts`.
- Do not reintroduce `clientCapabilities`.
- Do not reintroduce local execution of ACP file or terminal methods.
- If replay later needs compaction, add it as a separate machine input or replay strategy module. Do not mix it into the bridge choreography.

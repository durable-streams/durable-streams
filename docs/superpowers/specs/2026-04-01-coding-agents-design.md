# @durable-streams/coding-agents

A TypeScript library and CLI that makes coding agent sessions durable and shareable. Spawns Claude Code or Codex, records every protocol message to a durable stream, and provides a browser-safe client for multi-device, multi-user access.

## Problem

Coding agent sessions are ephemeral. When a sandbox shuts down, the conversation is lost. Resuming requires reconstructing prior context. Multi-device access (laptop, phone, web) requires a sync layer. Existing solutions couple session management, HTTP servers, and UI rendering into monolithic systems.

Previous approaches used ACP (Agent Client Protocol) as an abstraction layer over agents. ACP standardizes but also flattens: it loses agent-specific features, streaming fidelity, and native tool-call UX. The abstraction becomes a bottleneck.

## Solution

Use each agent's native protocol directly. Claude Code speaks NDJSON over WebSocket (`--sdk-url`). Codex speaks JSON-RPC over stdio. A thin bridge process accepts these connections, records every raw message to a durable stream, and relays client messages back. No protocol translation, no fidelity loss.

The stream stores raw events (event sourcing). Normalization into a unified format happens client-side, as a projection over the raw data. This means normalization bugs are fixable after the fact, and the stream is always the complete truth.

## Architecture

```
                        Durable Stream (remote)
                        ┌──────────────────────┐
  Client A ────────────>│                      │<─── Bridge (in sandbox)
  (browser) <───────────│   stream URL         │───>   │
                        │                      │       ├── WebSocket server (:port)
  Client B ────────────>│                      │       │     ↕
  (phone)   <───────────│                      │       ├── Claude Code (--sdk-url)
                        └──────────────────────┘       │   or Codex (stdio)
```

Three components:

1. **Bridge** (Node-only): spawns the agent, accepts its connection, relays all traffic through the durable stream.
2. **Client** (browser-safe): reads events from the stream with agent-specific normalizers, writes prompts/responses/cancel.
3. **CLI**: `start` and `resume` commands that wrap the bridge API.

## Stream envelope format

Every message on the stream is a JSON envelope containing the raw protocol message:

```typescript
// Agent messages
{
  agent: "claude" | "codex",
  direction: "agent",
  timestamp: number,
  raw: object  // exact message from agent protocol
}

// User messages
{
  agent: "claude" | "codex",
  direction: "user",
  timestamp: number,
  user: { name: string, email: string },
  raw: object  // client intent: prompt, permission response, or cancel
}

// Bridge control events
{
  agent: "claude" | "codex",
  direction: "bridge",
  timestamp: number,
  type: "session_started" | "session_resumed" | "session_ended",
}
```

For agent messages, `raw` is the exact NDJSON object (Claude) or JSON-RPC message (Codex) from the agent's output. For user messages, `raw` is **client intent**, not guaranteed-delivered traffic. Clients append directly to the stream; the bridge decides what to forward to the agent (e.g., dropping duplicate responses, queuing prompts). The stream records all client intent for observability, but the bridge is the authority on what the agent actually receives.

All writes to the stream (bridge and client) must use `IdempotentProducer` from `@durable-streams/client` for exactly-once semantics. Both use `autoClaim: true` so the server handles epoch fencing automatically. The durability guarantees differ:

- **Bridge**: producer ID `bridge-{sessionId}`. Restart-safe across sandbox replacement. On resume in a new sandbox, autoClaim fences out the zombie bridge from the previous sandbox. The bridge is a long-lived writer that survives across sandbox lifecycles.
- **Client**: random producer ID per instance (e.g., `client-{crypto.randomUUID()}`). Ephemeral: the producer identity is per browser tab/device instance, not per user, and does not survive tab closure. Each tab or device is an independent writer with no cross-tab coordination.

`IdempotentProducer.append()` is fire-and-forget, which is the right default for both bridge and client writes. The only durability requirement is at shutdown: `client.close()` and bridge `close()` must call `producer.flush()` (which flushes pending writes) before exiting. Note: `producer.close()` permanently closes the underlying stream, which would break resume/shareability. Normal teardown uses `flush()` only. Consumers should block teardown (e.g., `beforeunload`) until flush completes.

## Bridge

The bridge is a single Node process with three responsibilities:

### 1. Local WebSocket server

Listens on a local port. For Claude Code, the bridge passes `--sdk-url ws://localhost:{port}/ws/cli/{sessionId}` so the agent connects back. For Codex, the adapter uses stdio pipes instead.

### 2. Agent adapter

Each agent gets an adapter that handles spawning, protocol framing, and lifecycle. The adapter interface:

```typescript
interface AgentAdapter {
  spawn(options: SpawnOptions): AgentConnection
}

interface AgentConnection {
  onMessage(handler: (raw: object) => void): void
  send(raw: object): void
  kill(): void
  on(event: "exit", handler: (code: number) => void): void
}
```

**Claude adapter**: spawns `claude` with `--sdk-url`, `--print`, `--output-format stream-json`, `--input-format stream-json`. Parses incoming NDJSON lines from the WebSocket connection. Supports pass-through of agent options: `--model`, `--permission-mode`, `--verbose`, `--resume`.

**Codex adapter**: spawns `codex` with stdio pipes. Parses JSON-RPC from stdout. Supports equivalent option mapping.

Each adapter also implements:

```typescript
interface AgentAdapter {
  // ...
  parseDirection(raw: object): {
    type: "request" | "response" | "notification"
    id?: string | number
  }
  isTurnComplete(raw: object): boolean
  translateClientIntent(raw: object): object
  prepareResume(
    history: StreamEnvelope[],
    options: ResumeOptions
  ): Promise<void>
}
```

`parseDirection` lets the bridge track pending request IDs without understanding protocol internals. `isTurnComplete` returns true when a message signals the end of a prompt turn (Claude: `result` message; Codex: JSON-RPC response to the prompt request). The bridge uses this to dequeue the next prompt. `translateClientIntent` converts generic client intent (`user_message`, `control_response`, `interrupt`) into the agent's native wire format. Claude's adapter passes through unchanged; Codex's adapter maps to JSON-RPC. `prepareResume` reconstructs local session files from stream history before spawning with resume flags.

### 3. Stream relay

The bridge is a pure relay. It does not interpret, approve, or handle message content. All it does:

- Agent message received → wrap in envelope → append to stream
- Client message read from stream → unwrap → translate via `adapter.translateClientIntent()` → send to agent via `connection.send()`

Pending request tracking:

- Bridge tracks IDs of agent-initiated requests using `parseDirection`
- Duplicate client responses for the same ID are dropped (only the first is forwarded)
- Cancel is the one exception to pure relay: for each pending request ID, the bridge appends a cancellation response envelope to the stream (for resume reconstruction), then sends it directly to the agent. Direct send is required because the relay loop would drop responses for IDs cleared during cancel. After resolving pending requests, the bridge sends the translated cancel signal to the agent. The agent's turn-complete response triggers the next queued prompt through the normal path.

## Public API

### Bridge (Node-only)

```typescript
import { createSession } from "@durable-streams/coding-agents"

const session = await createSession({
  agent: "claude",
  streamUrl: "https://streams.example.com/v1/stream/my-session",
  cwd: "/workspace/project",
  model: "opus",
  permissionMode: "auto",
})

// session.streamUrl — the shareable stream URL
// session.close() — graceful shutdown
```

`createSession` handles:

- Creating the durable stream (or connecting to an existing one)
- Spawning the agent with the appropriate adapter
- Starting the WebSocket server (for Claude) or stdio pipes (for Codex)
- Bidirectional relay between agent and stream
- Writing `session_started` control event

### Client (browser-safe)

```typescript
import { createClient } from "@durable-streams/coding-agents/client"

const client = createClient({
  agent: "claude",
  streamUrl: "https://streams.example.com/v1/stream/my-session",
  user: { name: "Kyle", email: "kyle@example.com" },
})

// Send a prompt
client.prompt("Refactor the auth module")

// Respond to a permission request
client.respond(requestId, { behavior: "allow" })

// Cancel current turn
client.cancel()

// Read normalized events
for await (const event of client.events()) {
  // unified format regardless of claude vs codex
}

await client.close()
```

Normalization transforms are tree-shakeable. The `agent` field on each stream envelope tells the client which normalizer to apply. If you only use Claude sessions, the Codex normalizer is not bundled.

## CLI

```bash
# Start a Claude session
npx @durable-streams/coding-agents start --agent claude

# Start with options
npx @durable-streams/coding-agents start --agent codex --model gpt-4.1 --cwd /workspace/project

# Explicit stream URL
npx @durable-streams/coding-agents start --agent claude --stream-url https://streams.example.com/v1/stream/my-session

# Resume an existing stream in a new sandbox
npx @durable-streams/coding-agents resume --stream-url https://streams.example.com/v1/stream/abc123
```

**`start`**: creates a stream, spawns the agent, prints the stream URL and (if applicable) a shareable view URL. Stays alive until the agent exits.

**`resume`**: reads history from an existing stream, adapter reconstructs local session files with path rewriting, spawns agent with `--resume`. Writes `session_resumed` control event.

Configuration via `DURABLE_STREAMS_URL` environment variable for the base URL. The CLI auto-generates a unique stream path per session. `--stream-url` overrides for explicit control.

## Resume strategy

When the bridge starts with a stream that has existing history:

1. Read all messages from the stream, capture `historyResponse.offset`
2. Adapter's `prepareResume` reconciles stream history into local session files:
   - **Claude**: write raw messages as JSONL to `~/.claude/projects/<project>/<sessionId>.jsonl`, apply path rewriting (string replacement for changed sandbox mount paths)
   - **Codex**: equivalent reconstruction for Codex's local state format
3. Spawn agent with resume flag (e.g., `--resume <sessionId>` for Claude)
4. Write `session_resumed` control event to stream
5. Begin live-tailing from `historyResponse.offset`

### Resume reconciliation

Resume reconstruction includes all user prompts from stream history, regardless of whether they were forwarded before the bridge died. The agent will see them as part of its history and work through them on resume.

Reconciliation rules:

- **Permission responses**: if multiple clients responded to the same request ID, include only the first by stream order (the one the bridge would have forwarded).
- **Cancel-synthesized responses**: the bridge writes cancellation response envelopes to the stream. Include these in the reconstruction since the agent received them.

The adapter receives the full stream history and applies these rules during reconstruction.

### Path rewriting

Path rewriting handles sandbox remounting:

```typescript
rewritePaths: {
  "/old/sandbox/path": "/workspace/project",
}
```

Applied as string replacements across the reconstructed session files.

## Multi-user

Multiple clients connect to the same stream URL with different `user` identities. Each message includes `user: { name, email }` in the envelope. The bridge relays all client messages to the agent. The UI uses the `user` field to show who said what.

Prompt turn serialization: the bridge queues prompts and only sends one to the agent at a time, since agents expect turns to complete sequentially.

## Normalization (client-side)

Raw stream events are agent-specific. The client library provides normalizers that project raw events into a unified format:

```typescript
// Unified event types (examples)
type NormalizedEvent =
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; tool: string; input: object }
  | { type: "tool_result"; output: string }
  | { type: "permission_request"; id: string; tool: string; input: object }
  | { type: "stream_delta"; content: string }
  | { type: "turn_complete"; cost?: object }
// ...
```

Each normalizer maps agent-specific message types:

- Claude: `assistant`, `stream_event`, `control_request` (can_use_tool), `result`, etc.
- Codex: `agentMessage`, `commandExecution`, `fileChange`, approval requests, etc.

Because normalization is a projection over immutable raw events, bugs in normalizers can be fixed and re-applied without data loss.

## Package structure

```
packages/coding-agents/
  package.json
  tsdown.config.ts
  tsconfig.json
  src/
    index.ts              — exports createSession + types
    client.ts             — exports createClient (browser-safe)
    bridge.ts             — WebSocket server + stream relay + lifecycle
    types.ts              — shared envelope, event, adapter types
    adapters/
      claude.ts           — spawn, NDJSON parsing, resume reconstruction
      codex.ts            — spawn, JSON-RPC parsing, resume reconstruction
      types.ts            — adapter interface
    normalize/
      claude.ts           — raw Claude events → unified format
      codex.ts            — raw Codex events → unified format
      types.ts            — unified event types
  cli/
    index.ts              — CLI entrypoint (start, resume)
  test/
    bridge.test.ts
    client.test.ts
    adapters/
      claude.test.ts
      codex.test.ts
    normalize/
      claude.test.ts
      codex.test.ts
```

**Three entrypoints:**

- `src/index.ts` — bridge API (Node-only, uses `child_process` and `ws`)
- `src/client.ts` — client + normalizers (browser-safe)
- `cli/index.ts` — CLI binary

**Location:** `packages/coding-agents/` in the durable-streams monorepo.

**Dependencies:**

- `@durable-streams/client` (`DurableStream`, `IdempotentProducer`, `StreamResponse`)
- `ws` (WebSocket server for Claude adapter)

## What this does NOT do

- Render events (separate UI concern, events are already structured)
- Host a web app view (separate deployment, uses the client library)
- Manage multiple sessions (one bridge = one session)
- Run an HTTP server (WebSocket server is local, agent-facing only)
- Install agent binaries (user's responsibility, resolved from PATH or npx)
- Normalize on write (raw events are the source of truth)

## Agent compatibility

Targets:

- Claude Code via `--sdk-url` WebSocket protocol
- Codex via stdio JSON-RPC protocol

Both protocols are reverse-engineered from The Companion (MIT licensed). The protocols are stable in practice since breaking changes would affect all existing SDK integrations.

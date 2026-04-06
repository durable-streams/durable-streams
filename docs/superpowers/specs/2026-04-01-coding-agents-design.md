# @durable-streams/coding-agents

A TypeScript library and CLI for making Claude Code and Codex sessions durable, shareable, and multi-client safe by recording raw protocol traffic to a durable stream.

## Problem

Coding agent sessions are normally local and ephemeral.

- When the bridge process or sandbox dies, the active session dies with it.
- Multi-device access needs a shared source of truth.
- Generic protocol layers flatten away agent-native behavior and make approvals, streaming, and resume less faithful.

## Solution

Use each agent's native protocol directly and treat the durable stream as the event log.

- Claude Code uses its observed `--sdk-url` WebSocket protocol with NDJSON messages.
- Codex uses `codex app-server --listen stdio://` and speaks JSON-RPC.
- The bridge records raw agent messages to the stream and relays client intents back to the agent.
- Normalization happens client-side as a projection over immutable raw events.

That keeps the stream as the durable truth and lets client projections evolve without rewriting history.

## Architecture

```text
                        Durable Stream
                        ┌──────────────────────┐
  Browser / Phone ─────>│                      │<──── Bridge
  Browser / Phone <─────│      stream URL      │─────┐
                        │                      │     │
                        └──────────────────────┘     │
                                                     │
                                                     ├── Claude Code via WebSocket
                                                     └── Codex app-server via stdio
```

Three components:

1. Bridge: Node-only process that spawns the agent, records raw traffic, and applies forwarding rules.
2. Client: browser-safe reader/writer over the stream.
3. CLI: thin wrapper around the bridge API.

## Stream model

Every stream item is an envelope:

```ts
type AgentEnvelope = {
  agent: "claude" | "codex"
  direction: "agent"
  timestamp: number
  raw: object
}

type UserEnvelope = {
  agent: "claude" | "codex"
  direction: "user"
  timestamp: number
  user: { name: string; email: string }
  raw: ClientIntent
}

type BridgeEnvelope = {
  agent: "claude" | "codex"
  direction: "bridge"
  timestamp: number
  type: "session_started" | "session_resumed" | "session_ended"
}
```

Client intents are generic:

```ts
type ClientIntent =
  | { type: "user_message"; text: string }
  | {
      type: "control_response"
      response: {
        request_id: string | number
        subtype: "success" | "cancelled"
        response: object
      }
    }
  | { type: "interrupt" }
```

The stream stores client intent, not guaranteed-delivered bridge output. The bridge is the authority on what actually gets forwarded to the agent.

## Durable boundary

The durable source of truth is:

- user-authored intents written to the stream
- persisted raw agent messages
- bridge lifecycle events

The bridge does not try to make every transient in-memory agent state durable.

That distinction matters most for resume:

- durable prompts are replayable
- duplicate client responses are reconciled by bridge rules
- pending approval wait state is not itself the durable object unless the agent exposes a stable resume model for it

This is the key product boundary: resume reconstructs durable user intent, not arbitrary live agent waiting state.

## Bridge behavior

The bridge:

- opens or connects to the durable stream
- spawns the selected agent adapter
- writes `session_started` or `session_resumed`
- records every raw agent message
- tails live user events from the stream
- translates client intents to agent-native messages
- serializes prompts so only one prompt is in flight at a time

Forwarding rules:

- only one prompt is forwarded at a time
- duplicate responses for the same pending request id are dropped
- `interrupt` synthesizes cancellation responses for all pending requests before sending the native interrupt signal

The bridge also exposes in-memory debug hooks for:

- forwarded agent traffic
- raw agent messages

Those hooks are used by tests to validate bridge semantics without expanding the persisted public stream protocol.

## Agent adapters

Shared adapter shape:

```ts
interface AgentAdapter {
  readonly agentType: "claude" | "codex"
  spawn(options: SpawnOptions): Promise<AgentConnection>
  parseDirection(raw: object): MessageClassification
  isTurnComplete(raw: object): boolean
  translateClientIntent(raw: ClientIntent): object
  prepareResume(
    history: StreamEnvelope[],
    options: ResumeOptions
  ): Promise<{
    resumeId: string
    forceSeedWorkspace?: boolean
    resumeTranscriptSourcePath?: string
  }>
  isReadyMessage?: (raw: object) => boolean
}
```

### Claude

Claude is driven through its WebSocket SDK path:

- spawn `claude` with `--sdk-url`, `--print`, `--output-format stream-json`, `--input-format stream-json`
- accept the websocket connection locally
- persist raw Claude wire messages unchanged
- treat `result` as turn completion

Resume is transcript-based:

- same-cwd resume works by reconstructing or copying the Claude transcript JSONL under `~/.claude/projects/<sanitized-full-cwd>/<session>.jsonl`
- path rewriting is applied to reconstructed transcript content
- if Claude rejects a cross-cwd synthetic resume with `No conversation found with session ID`, the adapter seeds a real Claude session in the target cwd, overwrites the seeded transcript with reconstructed history, and resumes using the seeded session id

That seeded-workspace fallback is an adapter implementation detail. It exists because Claude binds resumability to workspace-local registration, not just transcript contents.

### Codex

Codex is driven through `codex app-server`:

- spawn `codex app-server --listen stdio://`
- `initialize`
- `thread/start` or `thread/resume`
- `turn/start`
- `turn/interrupt`
- answer approval and user-input server requests over JSON-RPC

Turn completion is based on `turn/completed`.

Codex supports additional options through the library API:

- `approvalPolicy`
- `sandboxMode`
- `experimentalFeatures`
- `developerInstructions`
- `env`

## Resume strategy

When resuming from a stream with history:

1. Read full history and capture the stream offset.
2. Let the adapter inspect history and determine the native resume path.
3. Reconstruct agent-local state if needed.
4. Spawn the agent in resume mode.
5. If direct resume fails and the adapter has a safe fallback, use it.
6. Write `session_resumed`.
7. Start live relay from the stored stream offset.

Reconciliation rules:

- include durable prompts from stream history
- include only the first effective response for a given request id
- include bridge-synthesized cancellation responses because the agent actually received them
- replay unfinished prompts after restart rather than trying to reconstruct transient waiting state

For Codex, thread resume is native and direct.

For Claude:

- same-cwd resume is direct
- cross-cwd resume uses the seeded-workspace fallback described above

## Multi-user behavior

Multiple clients can write to the same stream URL with different `user` identities.

The bridge does not merge user identities into a single logical client. Instead:

- every client writes its own intents
- the stream keeps all intents for observability
- the bridge decides which intents become effective agent traffic

This is what makes duplicate-response races testable and replayable.

## Normalization

Client-side normalizers project raw agent events into a unified event model:

- `assistant_message`
- `stream_delta`
- `tool_call`
- `permission_request`
- `turn_complete`
- `status_change`
- `session_init`
- `unknown`

Normalization is intentionally a projection, not the stored truth. Raw envelopes remain the durable source of record.

## Public API

Bridge API:

```ts
import { createSession } from "@durable-streams/coding-agents"

const session = await createSession({
  agent: "claude",
  streamUrl: "https://streams.example.com/v1/stream/my-session",
  cwd: "/workspace/project",
  permissionMode: "plan",
})

await session.close()
```

Client API:

```ts
import { createClient } from "@durable-streams/coding-agents/client"

const client = createClient({
  agent: "codex",
  streamUrl: "https://streams.example.com/v1/stream/my-session",
  user: { name: "Kyle", email: "kyle@example.com" },
})

client.prompt("Refactor the auth module")
client.respond(requestId, { behavior: "allow" })
client.cancel()

for await (const event of client.events()) {
  // normalized agent events, bridge events, and user envelopes
}
```

## CLI

Current CLI surface is intentionally small:

```bash
coding-agents start  --agent claude --stream-url <url> [--cwd <path>] [--model <model>] [--permission-mode <mode>] [--verbose]
coding-agents resume --agent codex  --stream-url <url> [--cwd <path>] [--model <model>] [--permission-mode <mode>] [--verbose]
```

The library API is richer than the CLI. Advanced Codex options are available programmatically but are not yet surfaced through CLI flags.

## Validation status

The package is validated by:

- unit tests for bridge, adapters, client, and normalizers
- scenario DSL tests
- live real-agent coverage for Claude and Codex

Live coverage currently includes:

- simple prompt round trips
- approval allow / deny / cancel
- interrupt behavior
- restart / resume
- prompt replay after restart
- multi-client duplicate response races
- queued prompts
- Codex `file_change`, `permissions`, and `request_user_input`
- Claude cross-cwd resume via seeded-workspace fallback

## What this package does not do

- render UI
- host a browser app
- manage many sessions from one bridge process
- install Claude or Codex binaries
- persist bridge debug telemetry on-stream by default

## Known caveats

- The CLI still exposes only a minimal option set.
- Bridge debug telemetry is in-memory only today.
- Claude cross-cwd resume depends on the seeded-workspace fallback because direct synthetic transcript resume is not sufficient in a new real cwd.

# @durable-streams/agent-client-protocol

A TypeScript library that bridges ACP (Agent Client Protocol) coding agents to a remote durable stream. Runs inside a sandbox, spawns an agent subprocess, and forwards all communication through a single durable stream URL.

## Problem

Coding agent sessions are ephemeral. When a sandbox shuts down, the conversation is lost. Resuming later requires spinning up a new sandbox and reconstructing the prior context. Multi-device access (laptop, phone, web) requires a sync layer. Today's solutions (Sandbox Agent, Superset) couple session management, HTTP servers, and UI rendering into monolithic systems.

## Solution

Decouple the agent lifecycle from the transport. A single durable stream URL IS the session. The library provides two things:

1. **Bridge** (Node-only): spawns an ACP agent process and pipes its stdio to/from a durable stream
2. **Client** (browser-safe): writes user prompts to the same stream

Multiple clients can connect to the same stream. The agent's events are ACP-standard `session/update` notifications, which are already agent-agnostic by spec.

## Architecture

```
                    Durable Stream (remote)
                    ┌──────────────────────┐
  Client A ────────>│                      │<──────── Bridge (in sandbox)
  (laptop)  <───────│   stream URL         │────────>   │
                    │                      │            ├── ACP subprocess
  Client B ────────>│                      │            │   (claude-acp,
  (phone)   <───────│                      │            │    codex-acp, etc.)
                    └──────────────────────┘            │
                                                        └── child_process.spawn
```

## Stream protocol

Every message on the stream is a JSON object:

```typescript
// Agent events (written by bridge)
{
  direction: "agent",
  timestamp: number,
  payload: JsonRpcMessage  // raw ACP JSON-RPC from agent stdout
}

// User prompts (written by clients)
{
  direction: "user",
  timestamp: number,
  user: { name: string, email: string },
  payload: JsonRpcMessage  // session/prompt JSON-RPC request
}

// Control events (written by bridge)
{
  direction: "agent",
  timestamp: number,
  type: "session_resumed" | "session_ended",
  payload?: JsonRpcMessage
}
```

The ACP `session/update` notification format is standardized across agents. All agents emit the same discriminated union (`user_message_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `permission_requested`, etc.). Clients can render these without agent-specific code.

## Public API

### Bridge (Node-only)

```typescript
import { createAgentStream } from "@durable-streams/agent-client-protocol"

const session = await createAgentStream({
  agent: "claude",
  streamOptions: {
    url: "https://streams.example.com/v1/stream/conv-abc123",
  },
  cwd: "/workspace/my-project",
  mcpServers: [],
  replayOptions: {
    maxEvents: 200,
    maxChars: 12000,
    rewritePaths: {
      "/old/sandbox/path": "/workspace/my-project",
    },
  },
})

await session.close()
```

`createAgentStream` handles:

- Creating the stream if it doesn't exist (or connecting to an existing one)
- Spawning the ACP agent process (resolved from PATH or npx)
- `initialize` handshake with the agent
- Detecting fresh vs resume based on stream contents
- Bidirectional forwarding between agent stdio and the stream
- Graceful shutdown on `close()`

### Client (browser-safe)

```typescript
import { createStreamClient } from "@durable-streams/agent-client-protocol/client"

const client = createStreamClient({
  streamOptions: {
    url: "https://streams.example.com/v1/stream/conv-abc123",
  },
  user: { name: "Kyle", email: "kyle@example.com" },
})

await client.prompt("Refactor the auth module to use JWT")
await client.cancel()
await client.close()
```

`createStreamClient` handles:

- Appending wrapped `session/prompt` JSON-RPC requests to the stream
- Appending `session/cancel` notifications
- Reading agent events from the stream (for UI rendering)

## Resume strategy

When the bridge starts, it reads the stream from offset `"-1"` (beginning):

**Fresh stream (empty):**

1. Send `initialize` to agent
2. Send `session/new` with `cwd` and `mcpServers`
3. Begin forwarding

**Existing stream with history (resume):**

1. Read all existing messages
2. Extract `sessionId` from original `session/new` response
3. Collect `user_message_chunk` and `agent_message_chunk` events
4. Build synthesized replay text:
   - Serialize conversation as human-readable transcript
   - Apply path rewriting (simple string replacement)
   - Truncate to `maxChars` from the end (preserve recent context)
5. Send `initialize` to agent
6. Send `session/new` (fresh agent session)
7. Send `session/prompt` with replay prepended
8. Write `session_resumed` control event to stream
9. Resume normal forwarding

### Path rewriting

Sandboxes mount repos at different paths. The replay options accept a path mapping:

```typescript
rewritePaths: {
  "/home/user/project": "/workspace/project",
  "/tmp/sandbox-abc": "/workspace",
}
```

Applied as string replacements across the replay text before injection.

### Why not ACP session/load?

Both Claude Code and Codex advertise `loadSession: true` in their ACP capabilities. However, `session/load` reads from local JSONL files on the agent's filesystem. When the sandbox is torn down, those files are gone. Synthesized replay is portable across sandboxes and works with any agent regardless of local state.

## Package structure

```
packages/agent-client-protocol/
  package.json
  tsup.config.ts
  tsconfig.json
  src/
    index.ts        — exports createAgentStream
    client.ts       — exports createStreamClient (browser-safe)
    bridge.ts       — stdio <-> stream forwarding loop
    agent.ts        — spawn ACP process, manage lifecycle
    replay.ts       — read history, build replay text, rewrite paths
    types.ts        — shared types
```

**Location:** `/Users/kylemathews/programs/durable-streams/packages/agent-client-protocol/`

**Dependencies:**

- `@durable-streams/client` (stream read/write)
- `@agentclientprotocol/sdk` (ACP types, not runtime)

**Two entrypoints:**

- `@durable-streams/agent-client-protocol` (bridge, Node-only, uses child_process)
- `@durable-streams/agent-client-protocol/client` (prompt helper, browser-safe)

## What this does NOT do

- Install agent binaries (user's responsibility, or npx)
- Render events (separate effort, ACP events are already structured)
- Manage multiple sessions (one stream = one session)
- Run an HTTP server
- Provide a CLI (could be built on top)

## Multi-user

Multiple clients connect to the same stream with different `user` identities. Each prompt includes `user: { name, email }`. The bridge forwards all prompts to the agent. The UI uses the `user` field to show who said what.

## Agent compatibility

Tested with:

- Claude Code (`@agentclientprotocol/claude-agent-acp@0.24.2`): `loadSession: true`, full `session/update` support
- Codex (`@zed-industries/codex-acp@0.10.0`): `loadSession: true`, full `session/update` support

Should work with any ACP-compliant agent that emits `session/update` notifications.

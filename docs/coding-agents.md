---
title: Coding Agents
description: >-
  Durable, shareable Claude Code and Codex sessions on top of Durable Streams.
outline: [2, 3]
---

# Coding Agents

`@durable-streams/coding-agents` bridges Claude Code and Codex to Durable
Streams so a coding session becomes:

- durable across bridge restarts
- readable from multiple clients at once
- resumable from stream history
- inspectable both as raw agent protocol traffic and normalized client events

## What gets persisted

The stream is the source of truth. It stores:

- user-authored intents such as prompts, approval responses, and interrupts
- raw agent protocol messages
- bridge lifecycle events

The bridge is responsible for deciding what actually reaches the agent. That is
why duplicate approval responses, queued prompts, and synthesized interrupt
cancellations are bridge semantics, not just stream semantics.

## Start a session

```ts
import { createSession } from "@durable-streams/coding-agents"

const session = await createSession({
  agent: "claude",
  streamUrl: "https://streams.example.com/v1/stream/agent-demo",
  cwd: process.cwd(),
  permissionMode: "plan",
})
```

For Codex, the library also supports granular approval policy, sandbox mode,
experimental features, developer instructions, and extra process env.

## Attach clients

Any number of clients can tail the same stream and append new user intents.

```ts
import { createClient } from "@durable-streams/coding-agents/client"

const client = createClient({
  agent: "claude",
  streamUrl: "https://streams.example.com/v1/stream/agent-demo",
  user: { name: "Kyle", email: "kyle@example.com" },
})

client.prompt("Reply with exactly PONG and nothing else.")

for await (const event of client.events()) {
  if (event.direction === "agent" && event.event.type === "assistant_message") {
    console.log(event.event.content)
  }
}
```

## Shared approvals

Approval requests are just another part of the shared session. One client can
see the request and another client can answer it.

```ts
client.respond("perm-1", {
  behavior: "allow",
  updatedInput: {},
})
```

Only the first effective response for a pending request is forwarded to the
agent. Later duplicate responses remain visible on the stream as user intent,
but they are dropped by the bridge.

## Resume model

On restart, the bridge reconstructs the session from stream history:

- raw agent history is passed to the adapter's native resume path when possible
- unfinished prompts are replayed if the prior turn never completed
- transient in-memory wait state is not treated as the durable object unless the
  agent exposes a stable native resume mechanism for it

### Claude

Claude resume is transcript-based. Cross-cwd resume works, but Claude may reject
a synthetic session in a new real workspace. In that case the adapter seeds the
target workspace with a real Claude session, rewrites the seeded transcript from
stream history, and resumes using the seeded Claude session id.

The durable identity is still the stream URL, not Claude's native session id.

### Codex

Codex uses `codex app-server` and resumes natively through `thread/resume`.

## CLI

```bash
coding-agents start \
  --agent codex \
  --stream-url https://streams.example.com/v1/stream/codex-demo \
  --cwd "$PWD" \
  --sandbox-mode workspace-write \
  --approval-policy on-request \
  --experimental-feature request_permissions_tool \
  --developer-instructions "Be concise."
```

Useful flags:

- `--agent`
- `--stream-url`
- `--cwd`
- `--model`
- `--permission-mode`
- `--approval-policy` for Codex
- `--sandbox-mode` for Codex
- `--developer-instructions` for Codex
- `--experimental-feature` for Codex
- `--env`
- `--verbose`

Claude-specific transcript rewriting and seeded-workspace fallback remain
library-only implementation details.

## Debugging

The bridge exposes in-memory debug hooks for:

- forwarded messages to the agent
- raw agent messages received by the bridge

It also supports persisted debug envelopes when `debugStream: true` is enabled.
That opt-in mode appends extra bridge events such as:

- `forwarded_to_agent`
- `agent_message_received`

The default path keeps the stream protocol clean.

## API entrypoints

Use the package entrypoints this way:

- `@durable-streams/coding-agents` for `createSession(...)`
- `@durable-streams/coding-agents/client` for `createClient(...)`
- `@durable-streams/coding-agents/normalize` for raw-message normalizers and normalized event types
- `@durable-streams/coding-agents/protocol` for raw Claude/Codex protocol types

The normalize and protocol entrypoints are advanced surfaces. Most applications
only need the session and client APIs.

## Test coverage

The package has:

- unit tests for adapters, bridge, client, and normalizers
- a scenario DSL for concise integration tests
- live Claude and Codex end-to-end tests
- checked-in raw protocol fixtures for normalizer regression coverage

Live coverage currently includes:

- prompt round trips
- approval allow / deny / cancel flows
- interrupts
- restart / resume
- prompt replay after restart
- queued prompts
- multi-client approval races
- Codex `file_change`, `permissions`, and `request_user_input`
- Claude cross-cwd resume

## Operational guidance

Runtime prerequisites:

- Node.js 18 or newer
- a Durable Streams server reachable from the bridge
- `claude` installed and authenticated for Claude sessions
- `codex` installed and authenticated for Codex sessions

Useful local checks:

```bash
claude --version
codex --version
```

Recommended test tiers:

- fast local/unit: `pnpm --filter @durable-streams/coding-agents test`
- manual live smoke:
  - `pnpm --filter @durable-streams/coding-agents test:live:smoke:claude`
  - `pnpm --filter @durable-streams/coding-agents test:live:smoke:codex`
- full live validation:
  - `pnpm --filter @durable-streams/coding-agents test:live:claude`
  - `pnpm --filter @durable-streams/coding-agents test:live:codex`

The live smoke GitHub workflow is intentionally manual and self-hosted because
it depends on authenticated local agent binaries.

Claude operational note:

- when resuming a session in a different real cwd, the adapter may seed the new
  workspace before resuming
- this is expected Claude-specific registration behavior, not a durable-stream
  replay failure

## Package links

- [Package README](https://github.com/durable-streams/durable-streams/blob/main/packages/coding-agents/README.md)
- [Design spec](https://github.com/durable-streams/durable-streams/blob/main/docs/superpowers/specs/2026-04-01-coding-agents-design.md)

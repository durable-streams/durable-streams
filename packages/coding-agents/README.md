# @durable-streams/coding-agents

Durable, shareable Claude Code and Codex sessions on top of a durable stream.

## What it does

- spawns Claude Code or Codex using each agent's native protocol
- records raw agent traffic to a durable stream
- lets multiple clients read the same session and append prompts, approval responses, or interrupts
- resumes sessions after bridge restarts
- normalizes raw events client-side without losing the raw source of truth

## Core model

The stream is the durable source of truth.

It stores:

- user-authored intents
- raw agent messages
- bridge lifecycle events

The bridge decides what actually reaches the agent. That matters for:

- duplicate approval responses
- queued prompts
- synthesized cancellation responses during interrupts

## Durable boundary

This package treats durable user intent as replayable and durable.

It does not promise exact reconstruction of arbitrary transient in-memory agent state. In practice:

- unfinished prompts are replayed after restart
- only the first effective approval response is treated as authoritative
- pending approval wait state is not itself the durable object unless the agent offers a stable native resume path for it

## Agent support

### Claude

- transport: WebSocket via `--sdk-url`
- turn completion: Claude `result`
- resume: transcript-based
- cross-cwd resume: uses a seeded-workspace fallback when Claude rejects direct synthetic resume in a new real cwd

### Codex

- transport: `codex app-server --listen stdio://`
- turn completion: `turn/completed`
- native resume: `thread/resume`
- supports granular approval policy, sandbox mode, experimental features, developer instructions, and env through the library API

## Library usage

```ts
import { createSession } from "@durable-streams/coding-agents"
import { createClient } from "@durable-streams/coding-agents/client"

const session = await createSession({
  agent: "claude",
  streamUrl: "https://streams.example.com/v1/stream/my-session",
  cwd: process.cwd(),
  permissionMode: "plan",
})

const client = createClient({
  agent: "claude",
  streamUrl: session.streamUrl,
  user: { name: "Kyle", email: "kyle@example.com" },
})

client.prompt("Reply with exactly PONG and nothing else.")

for await (const event of client.events()) {
  // normalized agent events, bridge events, and user envelopes
}
```

## CLI

```bash
coding-agents start  --agent claude --stream-url <url>
coding-agents resume --agent codex  --stream-url <url>
```

Current CLI flags:

- `--agent`
- `--stream-url`
- `--cwd`
- `--model`
- `--permission-mode`
- `--approval-policy` (Codex only)
- `--sandbox-mode` (Codex only)
- `--developer-instructions` (Codex only)
- `--experimental-feature` (repeatable, Codex only)
- `--env` (repeatable `KEY=value`)
- `--verbose`

Example:

```bash
coding-agents start \
  --agent codex \
  --stream-url https://streams.example.com/v1/stream/codex-demo \
  --cwd "$PWD" \
  --sandbox-mode workspace-write \
  --approval-policy on-request \
  --experimental-feature request_permissions_tool \
  --experimental-feature default_mode_request_user_input \
  --developer-instructions "Be concise." \
  --env FOO=bar
```

Claude-specific resume and path-rewrite controls remain library-only because they
are adapter-internal recovery details, not stable end-user CLI concepts.

## API surface

Default entrypoints:

- `@durable-streams/coding-agents` for `createSession(...)`
- `@durable-streams/coding-agents/client` for `createClient(...)`

Advanced entrypoints:

- `@durable-streams/coding-agents/normalize` for raw-message normalizers and normalized event types
- `@durable-streams/coding-agents/protocol` for raw Claude/Codex protocol types

Bridge debug hooks and persisted `debugStream` telemetry are advanced diagnostic
surfaces, not the normal application path.

## Testing model

This package has:

- unit tests for adapters, bridge, client, and normalizers
- a scenario DSL for concise integration tests
- live Claude and Codex end-to-end tests
- checked-in Claude and Codex raw-history fixtures for normalizer regression coverage

Useful commands:

- `pnpm --filter @durable-streams/coding-agents test`
- `pnpm --filter @durable-streams/coding-agents test:live`
- `pnpm --filter @durable-streams/coding-agents test:live:smoke`
- `pnpm --filter @durable-streams/coding-agents test:live:smoke:claude`
- `pnpm --filter @durable-streams/coding-agents test:live:smoke:codex`
- `pnpm --filter @durable-streams/coding-agents test:live:claude`
- `pnpm --filter @durable-streams/coding-agents test:live:codex`

Live coverage currently includes:

- prompt round trips
- allow / deny / cancel approvals
- interrupts
- restart / resume
- prompt replay after restart
- queued prompts
- multi-client approval races
- Codex `file_change`, `permissions`, and `request_user_input`
- Claude cross-cwd resume

## Debugging

The bridge exposes in-memory debug hooks for:

- forwarded traffic to the agent
- raw agent messages seen by the bridge

It also supports persisted bridge telemetry when `debugStream: true` is set on
`createSession(...)`. That opt-in mode appends bridge debug envelopes like:

- `forwarded_to_agent`
- `agent_message_received`

The default path still only writes user intents, raw agent messages, and bridge
lifecycle events.

These are used heavily in tests to validate bridge semantics like:

- `first_response_wins`
- `single_in_flight_prompt`
- interrupt ordering

There is also a macOS helper script for Claude resume forensics:

- [trace-claude-resume.sh](../../scripts/trace-claude-resume.sh)

## Operational guidance

Runtime assumptions:

- Node.js 18+
- a reachable Durable Streams server
- `claude` installed and already authenticated for Claude sessions
- `codex` installed and already authenticated for Codex sessions

Expected command checks:

- `claude --version`
- `codex --version`

CI guidance:

- the default fast suite should stay credential-free
- live agent tests are intentionally manual/self-hosted
- `test:live:smoke:claude` and `test:live:smoke:codex` are the cheapest recurring live checks

Claude-specific operational note:

- cross-cwd resume may require the seeded-workspace fallback
- this is expected Claude behavior, not a stream inconsistency
- the durable session identity remains the stream URL

## Important caveat

Claude session ids are effectively workspace-local registration ids for cross-cwd resume. The durable session identity is the stream, not Claude's native session id.

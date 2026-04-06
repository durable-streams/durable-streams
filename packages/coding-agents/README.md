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

Current CLI flags are intentionally small:

- `--agent`
- `--stream-url`
- `--cwd`
- `--model`
- `--permission-mode`
- `--verbose`

The JS API is richer than the CLI today.

## Testing model

This package has:

- unit tests for adapters, bridge, client, and normalizers
- a scenario DSL for concise integration tests
- live Claude and Codex end-to-end tests

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

These are used heavily in tests to validate bridge semantics like:

- `first_response_wins`
- `single_in_flight_prompt`
- interrupt ordering

There is also a macOS helper script for Claude resume forensics:

- [trace-claude-resume.sh](../../scripts/trace-claude-resume.sh)

## Important caveat

Claude session ids are effectively workspace-local registration ids for cross-cwd resume. The durable session identity is the stream, not Claude's native session id.

# PRD: Claude Code live session sharing via Durable Streams

**Status:** Draft
**Date:** 2026-03-25
**Authors:** Kevin, Claude

---

## Problem

Claude Code sessions are local and ephemeral. There's no way to:

- Watch a colleague's CC session in real-time
- Share a live session URL so others can follow along
- Resume or fork someone else's session from another machine

This limits collaboration in teams using CC for development.

## Goal

Enable live, read-only sharing of Claude Code sessions over Durable Streams.

A user runs a CLI command, gets a URL, and anyone with that URL can watch the session unfold in real-time — including joining mid-session and catching up efficiently.

## Non-goals (Tier 1)

- **Read-write collaboration** — viewers are read-only, they cannot interact with the shared session
- **Filesystem sync** — viewers see the conversation stream, not the code changes
- **Session forking or merging** — no branching, no reconciliation
- **Claude Code integration** — no `/share` slash command or CC plugin; Tier 1 is a standalone CLI tool
- **Authentication** — assumed to be handled at the infrastructure layer (Caddy auth, signed URLs, network-level)

These are all planned for later tiers.

## User experience

### Sharing a session

```
$ ds-cc share --session <session-id> --server https://ds.example.com
Sharing session curious-munching-clarke...
Stream URL: https://ds.example.com/cc/47515c25-d702-4c25-b772-a2147aa63f56

Share this URL with others to let them follow your session.
Press Ctrl+C to stop sharing.
```

The command:

1. Locates the session's JSONL file on disk
2. Creates a Durable Stream at the server
3. Scans the JSONL backwards from the end of the file to find the last `compact_boundary` entry and writes from that point forward (everything before it is superseded by the compaction summary). If no compaction boundary is found, writes the entire file.
4. Continues tailing the file, appending new entries as they appear
5. Runs until interrupted or the CC session ends

### Following a session

```
$ ds-cc follow https://ds.example.com/cc/47515c25-d702-4c25-b772-a2147aa63f56
Following session curious-munching-clarke...
Reading from latest checkpoint (compact boundary)...

User: I want to refactor the auth middleware to use JWT tokens instead of session cookies...

Claude: I'll start by reading the current auth middleware...
  [Read] src/middleware/auth.ts
  [Edit] src/middleware/auth.ts — replaced session cookie logic with JWT verification
  ...
```

The command:

1. Connects to the DS stream
2. Requests `offset=compact` to start from the latest compaction checkpoint (or `offset=-1` if no compaction has occurred)
3. Renders each JSONL entry as human-readable terminal output (user messages, assistant responses, tool calls and results)
4. Continues tailing via SSE for live updates

### Sharing the current session (convenience)

If the user is in a directory with an active CC session, the CLI can auto-detect it:

```
$ ds-cc share --server https://ds.example.com
Detected active session: curious-munching-clarke (47515c25-...)
Stream URL: https://ds.example.com/cc/47515c25-d702-4c25-b772-a2147aa63f56
```

Auto-detection: read `~/.claude/sessions/*.json`, find entries where `cwd` matches the current directory and `pid` is still running.

---

## Technical design

### Prerequisite: named checkpoints in the DS protocol

Before building the CC tooling, the Durable Streams protocol needs a new primitive: **named checkpoints**.

#### What

A checkpoint is a server-maintained pointer from a name to an offset in a stream. Clients can resolve a checkpoint name to an offset via a sentinel value in the `offset` query parameter.

#### Protocol semantics

- `GET {stream-url}?offset=<checkpoint-name>` — the server resolves the name to a stored offset and returns a **307 redirect** to `?offset={stored-offset}`. If no checkpoint with that name exists, redirects to `?offset=-1` (beginning of stream).
- Checkpoints are **last-write-wins** — each new checkpoint with the same name replaces the previous offset.
- Checkpoint names are strings matching `[a-z][a-z0-9-]*` (lowercase, alphanumeric, hyphens).

#### How checkpoints get set

Checkpoints are set **server-side** via a configurable matching function. For JSON-mode streams, the server inspects each appended JSON message and evaluates a `shouldCheckpoint` function:

```
shouldCheckpoint(message: JSON) → string | undefined
```

If it returns a string, the server stores the current append offset under that checkpoint name.

This keeps writers simple — they just append data. The server detects checkpoint-worthy entries based on content.

#### Caddy configuration

```caddyfile
durable_streams {
    checkpoint compact {
        json_match .type "system"
        json_match .subtype "compact_boundary"
    }
}
```

This tells the Caddy DS plugin: when a JSON message is appended where `.type == "system"` and `.subtype == "compact_boundary"`, store that offset as checkpoint `compact`.

#### Relationship to YJS snapshots

The existing YJS `offset=snapshot` mechanism is a special case of named checkpoints. Once checkpoints are in the base protocol, the YJS implementation can be refactored to use them — but that refactor is not a prerequisite for this work.

---

### Component 1: the sidecar (share command)

The `ds-cc share` command is a long-running process that tails a CC session's JSONL file and appends each line to a Durable Stream.

#### JSONL file location

CC stores session logs at:

```
~/.claude/projects/{encoded-cwd}/{session-id}.jsonl
```

Where `{encoded-cwd}` replaces `/` with `-` in the working directory path (e.g., `/Users/kevin/Desktop` becomes `-Users-kevin-Desktop`).

Given the session ID and working directory (from `~/.claude/sessions/{pid}.json`), the path is deterministic.

#### Stream creation

The sidecar creates a JSON-mode DS stream:

```
PUT {server}/cc/{session-id}
Content-Type: application/json
```

#### Appending entries

For each new line in the JSONL file, the sidecar appends it to the stream:

```
POST {server}/cc/{session-id}
Content-Type: application/json
Producer-Id: {machine-id}
Producer-Epoch: {start-timestamp}
Producer-Seq: {line-number}

{raw JSONL line}
```

Using idempotent producer headers ensures exactly-once delivery if the sidecar crashes and restarts.

#### Tailing mechanics

The sidecar watches the JSONL file for changes using filesystem notifications (e.g., `fs.watch` / `fsnotify`). On each change:

1. Read new lines since last known position (byte offset in file)
2. Append each line to the DS
3. Update the stored byte offset

This is a standard `tail -f` pattern.

#### Checkpoint detection

The sidecar does **not** need to detect checkpoints — the DS server handles this automatically via the `shouldCheckpoint` configuration. When the sidecar appends a `compact_boundary` entry, the server recognizes it and updates the `compact` checkpoint.

#### Session end

When the CC session ends (detected via process exit of the CC pid, or the JSONL file stops changing), the sidecar can optionally close the stream:

```
POST {server}/cc/{session-id}
Stream-Closed: true
```

This signals to viewers that the session is complete.

---

### Component 2: the viewer (follow command)

The `ds-cc follow` command connects to a shared DS stream and renders the session in the terminal.

#### Reading from checkpoint

```
GET {stream-url}?offset=compact
→ 307 redirect to ?offset={compact-boundary-offset}
```

If no compaction has occurred, the server redirects to `offset=-1` (start of stream).

#### Live tailing

After catching up, the viewer switches to SSE for live updates:

```
GET {stream-url}?offset={last-offset}&live=sse
```

#### Rendering

Each JSONL entry has a `type` field that determines how it's rendered:

| Entry type                              | Rendering                                   |
| --------------------------------------- | ------------------------------------------- |
| `user` (with `isCompactSummary: false`) | Show user message text                      |
| `user` (with `isCompactSummary: true`)  | Show "[Compacted context]" summary          |
| `assistant`                             | Show assistant text, tool calls             |
| `progress` / `agent_progress`           | Show subagent activity (indented/collapsed) |
| `system/compact_boundary`               | Show "[Session compacted]" marker           |
| `system/turn_duration`                  | Show turn timing stats                      |
| `file-history-snapshot`                 | Skip (internal bookkeeping)                 |
| `last-prompt`                           | Skip (internal bookkeeping)                 |

The viewer does not need to understand the full CC internal format — it renders what it can and skips what it doesn't recognize.

#### Minimal viable viewer

The simplest viewer just prints user messages and assistant text responses. Tool calls can be shown as one-liners (`[Read] src/foo.ts`, `[Edit] src/bar.ts — replaced X with Y`). This is enough to follow along.

A richer viewer (TUI or web) can be built later.

---

### Stream data format

The DS stream uses JSON mode (`Content-Type: application/json`). Each message in the stream is one CC JSONL entry, unmodified. No wrapper format, no intermediate schema.

This means:

- The stream is tightly coupled to CC's internal JSONL format
- If CC changes its format, the viewer needs updating
- But: no serialization/deserialization overhead, no information loss, simplest possible implementation

For Tier 1 this trade-off is acceptable. A stable intermediate format can be introduced later if needed.

---

## Deliverables

| #   | Deliverable                         | Description                                                                                     |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **Named checkpoints protocol spec** | Extension to PROTOCOL.md defining `offset=<name>` resolution and checkpoint semantics           |
| 2   | **Caddy checkpoint implementation** | Server-side `shouldCheckpoint` with JSON matching, checkpoint storage, `offset=<name>` redirect |
| 3   | **`ds-cc share` command**           | CLI tool that tails a CC JSONL file and appends to a DS stream                                  |
| 4   | **`ds-cc follow` command**          | CLI tool that reads a DS stream and renders it as terminal output                               |
| 5   | **Conformance tests**               | Tests for checkpoint creation, resolution, and fallback behavior                                |

### Ordering

1. **Checkpoints first** (deliverables 1-2, 5) — this is a general DS protocol feature, useful beyond CC
2. **CC tooling second** (deliverables 3-4) — built on top of checkpoints

---

## Resolved questions

1. **CLI package location** — an example inside the `examples/` folder of this repo.

2. **Stream URL structure** — `/cc/{session-id}` as default convention; users can provide arbitrary stream paths.

3. **Multiple compactions** — latest checkpoint only for Tier 1. Historical checkpoints deferred to later tiers.

4. **Stream lifetime** — deferred to later tiers.

5. **Viewer output format** — plain text for Tier 1.

6. **Active session detection** — auto-detect reads `~/.claude/sessions/*.json` and checks if the PID is alive. If multiple active sessions are found, prompt the user to choose which one to share.

---

## Future tiers (out of scope)

**Tier 2: session resume/fork**

- Read a shared stream, create a local CC session from it
- Requires filesystem sync (git branch per session)
- Single-writer: forked sessions diverge independently

**Tier 3: parallel collaboration + merge**

- Multiple CC instances on different machines working on the same codebase
- Git-based code reconciliation
- Agent-assisted JSONL context merging
- Commit-per-turn for trackability

**CC integration**

- `/share` slash command via CC skill/plugin
- `/follow` for in-CC viewing
- Hooks for automatic sharing (e.g., always share sessions in a team context)

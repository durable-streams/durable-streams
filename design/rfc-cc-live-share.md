# RFC: Claude Code live session sharing

**Status:** Draft
**Date:** 2026-03-25
**Authors:** Kevin, Claude
**Depends on:** [RFC: Named checkpoints for Durable Streams](rfc-named-checkpoints.md)

---

## Summary

This RFC describes a CLI tool (`ds-cc`) that enables live, read-only sharing of Claude Code sessions over Durable Streams. A user runs `ds-cc share` to export their active CC session to a DS stream; others run `ds-cc follow <url>` to watch it in real-time. Late joiners skip to the latest compaction checkpoint automatically.

This is Tier 1 — read-only streaming only. Session forking, merging, and CC integration are out of scope.

## Motivation

Claude Code sessions are local. If you're pair-programming with a colleague, debugging an issue for a teammate, or demonstrating a workflow, the only way to share what's happening is screen-sharing. This is lossy (resolution, latency), synchronous (both parties must be online), and doesn't integrate with any tooling.

Durable Streams already solve the hard infrastructure problems — durable append-only logs with SSE live tailing, offset-based resumption, and idempotent writes. CC sessions are already stored as append-only JSONL files. Connecting the two is a thin integration layer.

## Prerequisites

This RFC depends on the [named checkpoints](rfc-named-checkpoints.md) protocol extension. The DS server must be configured with a `compact` checkpoint rule matching CC's compaction boundary entries:

```caddyfile
durable_streams {
    checkpoint compact {
        json_match .type "system"
        json_match .subtype "compact_boundary"
    }
}
```

## Architecture

```
┌──────────────┐         ┌───────────┐         ┌──────────────┐
│  Claude Code │         │  DS Server│         │   Viewer(s)  │
│  (session)   │         │  (Caddy)  │         │  (ds-cc      │
│              │         │           │         │   follow)    │
│ {id}.jsonl ──┼── tail ─┼─▶ POST   │         │              │
│              │  ds-cc  │  append   │◀── GET ─┼── SSE tail   │
│              │  share  │           │  offset= │              │
│              │         │  ┌──────┐ │  compact │              │
│              │         │  │check-│ │         │              │
│              │         │  │points│ │         │              │
│              │         │  └──────┘ │         │              │
└──────────────┘         └───────────┘         └──────────────┘
```

There are two independent components:

1. **`ds-cc share`** — a sidecar process that tails the CC session's JSONL file and appends each entry to a DS stream
2. **`ds-cc follow`** — a viewer that reads the DS stream and renders the session as plain text in the terminal

Both are subcommands of a single `ds-cc` CLI tool, implemented as an example in the `examples/` folder of the Durable Streams repo.

---

## `ds-cc share`

### Usage

```
ds-cc share [--session <session-id>] --server <ds-server-url>
```

- `--session <session-id>` — the CC session UUID to share. Optional; if omitted, auto-detects the active session (see below).
- `--server <ds-server-url>` — the Durable Streams server URL (e.g., `https://ds.example.com`).

### Session discovery

CC stores session metadata at `~/.claude/sessions/{pid}.json`:

```json
{
  "pid": 12083,
  "sessionId": "47515c25-d702-4c25-b772-a2147aa63f56",
  "cwd": "/Users/kevin/Documents/Electric/development/durable-streams",
  "startedAt": 1774437965795,
  "kind": "interactive"
}
```

When `--session` is omitted, the CLI:

1. Reads all `~/.claude/sessions/*.json` files
2. Filters to sessions where `cwd` matches the current working directory
3. Filters to sessions where the `pid` is still alive (via `kill -0`)
4. If exactly one match: use it
5. If multiple matches: prompt the user to choose
6. If no matches: error with instructions to provide `--session` explicitly

### JSONL file location

Given a session ID and working directory, the JSONL file path is:

```
~/.claude/projects/{encoded-cwd}/{session-id}.jsonl
```

Where `{encoded-cwd}` is the working directory path with `/` replaced by `-` (e.g., `/Users/kevin/Desktop` → `-Users-kevin-Desktop`).

### Startup: initial sync

On startup, the sidecar needs to write the relevant portion of the existing JSONL file to the DS stream before it starts tailing for new entries.

**Algorithm:**

1. Read the JSONL file backwards from the end, line by line
2. Find the last entry where `type == "system"` and `subtype == "compact_boundary"`
3. If found: the write-start position is the byte offset of that line
4. If not found: the write-start position is byte offset 0 (beginning of file)
5. Create the DS stream:
   ```
   PUT {server}/cc/{session-id}
   Content-Type: application/json
   ```
6. Read forward from the write-start position, appending each line to the DS as a JSON message

**Why scan backwards:** The compaction boundary is near the end of the file. Scanning backwards avoids reading potentially megabytes of pre-compaction history. In practice, the boundary will be within the last few hundred lines.

**Why skip pre-compaction entries:** Everything before the compaction boundary is superseded by the compaction summary that follows it. The summary contains all the context a viewer needs. Writing the full history would waste bandwidth and storage for no benefit.

### Tailing: ongoing sync

After the initial sync, the sidecar watches the JSONL file for new appends:

1. Record the current byte offset (end of file after initial sync)
2. Watch the file for changes using filesystem notifications (`fs.watch` on Node.js, `fsnotify` on Go, etc.)
3. On each change:
   a. Seek to the stored byte offset
   b. Read all complete lines (terminated by `\n`) from that position
   c. For each line, append to the DS:

   ```
   POST {server}/cc/{session-id}
   Content-Type: application/json
   Producer-Id: {machine-id}
   Producer-Epoch: {sidecar-start-timestamp}
   Producer-Seq: {line-number}

   {raw JSONL line}
   ```

   d. Update the stored byte offset

**Idempotent producer headers** ensure exactly-once delivery:

- `Producer-Id`: a stable machine identifier (e.g., hostname or a persisted UUID)
- `Producer-Epoch`: the sidecar's start timestamp (changes on restart, establishing a new epoch)
- `Producer-Seq`: the JSONL line number (0-indexed from the write-start position). This is monotonically increasing and deterministic, so a restarted sidecar can resume from where it left off.

**Crash recovery:** If the sidecar crashes and restarts:

1. It re-scans the JSONL for the compaction boundary (same startup algorithm)
2. It creates a new epoch (new start timestamp)
3. It re-reads from the write-start position, re-appending all lines
4. The DS server deduplicates: lines already in the stream are accepted as idempotent successes (204), new lines are appended (200)

Wait — this won't work as described because the epoch changed. With a new epoch, `Producer-Seq` resets to 0, and the server accepts all appends as new. We need a different approach to crash recovery.

**Revised crash recovery:**

Option A: **Persist the producer state.** The sidecar writes its `Producer-Epoch` and current byte offset to a small state file (e.g., `~/.claude/ds-cc/{session-id}.state`). On restart, it reads the state file, resumes with the same epoch, and continues from the stored byte offset. The DS server detects duplicate `Producer-Seq` values and returns 204.

Option B: **Use line number as epoch-independent sequence.** Instead of epoch-based recovery, the sidecar queries the DS stream on startup (`HEAD {server}/cc/{session-id}`) to find the current tail offset, then reads the stream content to count how many lines are already there. It resumes appending from that point. This is simpler but requires reading back from the stream.

Option C: **Use `Stream-Seq` for ordering.** The sidecar uses `Stream-Seq` (the application-level sequence header) with the JSONL line number as the sequence value. On restart, it queries the stream for the last `Stream-Seq` and resumes from the next line. However, `Stream-Seq` is lexicographic and per-stream, not per-producer.

**Recommended: Option A.** Persisting a small state file is simple and robust. The state file contains:

```json
{
  "sessionId": "47515c25-...",
  "producerEpoch": 1774437965795,
  "byteOffset": 48231,
  "lineNumber": 42
}
```

On restart: read state → resume with same epoch → continue from stored line number. If the state file is missing or corrupt, fall back to a new epoch and re-append everything from the compaction boundary (the DS stream may have duplicates from the previous epoch, but this is a rare edge case and the viewer handles it gracefully since each JSONL entry has a `uuid`).

### Session end detection

The sidecar should detect when the CC session ends and clean up:

1. **PID monitoring**: periodically check if the CC process (from session metadata) is still alive via `kill -0 {pid}`
2. **On session end**:
   - Close the DS stream (`POST {server}/cc/{session-id}` with `Stream-Closed: true`)
   - Remove the state file
   - Print a message and exit

The poll interval for PID checking should be infrequent (e.g., every 5 seconds) since it's not latency-sensitive.

### Output

While running, the sidecar prints minimal status:

```
Sharing session curious-munching-clarke...
Stream URL: https://ds.example.com/cc/47515c25-d702-4c25-b772-a2147aa63f56

Share this URL with others to let them follow your session.
Press Ctrl+C to stop sharing.

[12:34:01] Synced 23 entries (initial)
[12:34:15] +1 entry (user message)
[12:34:22] +3 entries (assistant response)
...
```

---

## `ds-cc follow`

### Usage

```
ds-cc follow <stream-url> [--from-beginning]
```

- `<stream-url>` — the DS stream URL (as printed by `ds-cc share`)
- `--from-beginning` — start from `offset=-1` instead of the latest checkpoint. Useful for seeing the full post-compaction history.

### Connection flow

1. **Resolve starting offset:**
   - Default: `GET {stream-url}?offset=compact` → 307 redirect to the compaction boundary offset (or `-1` if no checkpoint)
   - With `--from-beginning`: use `offset=-1` directly
2. **Catch-up read:** `GET {stream-url}?offset={start-offset}` → read all existing entries
3. **Live tail:** `GET {stream-url}?offset={last-offset}&live=sse` → receive new entries as they arrive
4. **Stream closed:** when the SSE control event includes `streamClosed: true`, print a "session ended" message and exit

### Rendering

The viewer renders each JSONL entry as plain text. The rendering is lossy by design — the goal is to follow along, not to reproduce the exact CC terminal output.

#### Entry types and rendering

**User messages** (`type: "user"`, `isCompactSummary: false`):

```
━━━ User ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
I want to refactor the auth middleware to use JWT tokens
instead of session cookies.
```

Content is extracted from `message.content` — either a plain string or the first `text` block in a content array.

**Compaction summary** (`type: "user"`, `isCompactSummary: true`):

```
━━━ Session context (compacted) ━━━━━━━━━━━━━━━━━━━━━━━━━
[First 5 lines of summary text]
...
(full summary: 42 lines)
```

Show a truncated preview. The full summary is verbose and not useful for following along.

**Assistant messages** (`type: "assistant"`):

For `message.content` array items:

- `type: "text"`: print the text

  ```
  ━━━ Claude ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  I'll start by reading the current auth middleware to understand
  the existing session-based approach.
  ```

- `type: "tool_use"`: one-liner showing the tool name and key input

  ```
    ▶ Read src/middleware/auth.ts
    ▶ Edit src/middleware/auth.ts
    ▶ Bash: npm test
    ▶ Agent (Explore): "Find all session cookie references"
  ```

- `type: "thinking"`: skip (internal reasoning, not shown to viewers)

**Tool results** (`type: "tool_result"`):

Skip or show a brief summary. Tool results can be very large (file contents, command output). For the minimal viewer:

```
    ◀ Read: 142 lines
    ◀ Bash: exit code 0 (34 lines)
```

**Progress / agent progress** (`type: "progress"`, `type: "agent_progress"`):

Show subagent activity indented:

```
    ┊ Agent (Explore): searching for session cookie references...
    ┊   ▶ Grep "session.*cookie"
    ┊   ◀ 7 files matched
    ┊ Agent complete: found 12 references across 7 files
```

**System entries** (`type: "system"`):

- `subtype: "compact_boundary"`: `── Session compacted ──`
- `subtype: "turn_duration"`: skip or show `(turn: 42s, 152 messages)`

**Bookkeeping entries** (`type: "file-history-snapshot"`, `type: "last-prompt"`):

Skip entirely.

**Unknown types:**

Skip with no output. The viewer should be lenient — CC may add new entry types at any time.

#### Rendering approach

The renderer is a simple function: `renderEntry(entry: object) → string | null`. Returns a string to print, or null to skip. No state is needed between entries (each entry is rendered independently).

For the initial implementation, the renderer is a straightforward switch on `entry.type` (and `entry.subtype` / `entry.message.content[].type` for nested structures). No terminal UI framework is needed — just `console.log` / `process.stdout.write`.

### Reconnection

If the SSE connection drops (network issue, server restart, CDN cycle):

1. The DS client library handles reconnection automatically using the last received `streamNextOffset`
2. No data is lost — the DS protocol guarantees resumability from any offset
3. The viewer prints a brief `[reconnecting...]` / `[reconnected]` message

### Stream closed

When the stream is closed (CC session ended):

```
── Session ended ──
```

The viewer exits with code 0.

---

## Implementation details

### Language choice

TypeScript (Node.js). Reasons:

- The `@durable-streams/client` package is already available
- The existing DS `cli` package is TypeScript — can share infrastructure
- CC's JSONL format is JSON — native parsing
- Lives in the `examples/` folder alongside other TypeScript examples

### Package structure

```
examples/
  cc-live-share/
    package.json
    src/
      cli.ts          # argument parsing, subcommand dispatch
      share.ts        # ds-cc share implementation
      follow.ts       # ds-cc follow implementation
      session.ts      # CC session discovery (find JSONL, resolve paths)
      render.ts       # JSONL entry → plain text rendering
    README.md
```

### Dependencies

- `@durable-streams/client` — DS client library (stream creation, append, read, SSE)
- A CLI argument parser (e.g., `commander`, `yargs`, or minimal hand-rolled)
- No terminal UI libraries for Tier 1

### Testing

- **Unit tests for the renderer**: given a JSONL entry, assert the rendered output. These are pure functions, easy to test.
- **Unit tests for session discovery**: mock the `~/.claude/sessions/` directory, verify correct session resolution.
- **Integration test**: start a DS dev server, run `ds-cc share` against a test JSONL file, run `ds-cc follow` against the stream, verify the output matches expected rendering. This can be a simple script that asserts on stdout.

---

## Security considerations

### Session content sensitivity

CC sessions may contain:

- Source code (potentially proprietary)
- Tool call results (file contents, command output)
- API keys or secrets (if the user accidentally included them in prompts or if they appear in tool results)
- Internal architecture details

The DS stream URL is the only access control for Tier 1. Anyone with the URL can read the full session. This is acceptable for initial use (similar to sharing a screen), but later tiers should add authentication.

**The sidecar should print a warning on startup:**

```
⚠ Warning: This will share your CC session contents (messages, tool calls,
  file contents) with anyone who has the stream URL. Do not share sensitive
  sessions on untrusted networks.
```

### Thinking blocks

CC assistant messages may contain `type: "thinking"` content blocks with internal reasoning. The viewer skips these in rendering, but they are still present in the DS stream (since the sidecar appends raw JSONL). If thinking block privacy is a concern, the sidecar could strip them before appending. For Tier 1, we leave them in — the viewer doesn't display them, and anyone with stream access could see them via the raw DS API anyway.

---

## Limitations and future work

### Tier 1 limitations

- **Read-only** — viewers cannot interact with the session
- **No filesystem context** — viewers see the conversation but not the actual code changes. Tool results show file contents but there's no way to browse the working directory.
- **Plain text rendering** — no syntax highlighting, no markdown rendering, no collapsible sections. The output is functional but basic.
- **No authentication** — URL-based access only
- **Coupled to CC internals** — if CC changes its JSONL format, the renderer breaks. No stable API.

### Future tiers

**Tier 2: session resume/fork**

- `ds-cc fork <stream-url>` — create a local CC session from a shared stream
- Requires writing the stream entries into a local JSONL file and starting CC with `--resume`
- Requires filesystem sync via git (create a branch with the shared state)

**Tier 3: parallel collaboration**

- Multiple CC instances writing to the same codebase concurrently
- Git branch per session, merge via git + agent-assisted context reconciliation
- Commit-per-turn for traceable history

**CC native integration**

- `/share` skill/plugin — share directly from within CC
- `/follow` — watch a session from within CC
- Hooks for automatic sharing (e.g., team-wide session streaming)

**Web viewer**

- A browser-based viewer for the DS stream
- Richer rendering (syntax highlighting, file diffs, collapsible tool calls)
- No CLI required for viewers

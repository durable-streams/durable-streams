# PRD: sesh — Git-integrated CC session management via Durable Streams

**Status:** Draft
**Date:** 2026-04-02
**Authors:** Kevin, Claude

---

## Problem

Teams using Claude Code (and other coding agents) have no way to share, discover, or resume each other's sessions within a git workflow. Sessions are local, invisible to teammates, and lost when switching branches or machines.

The cods prototype proved that forking, cloning, and merging CC sessions works, but the workflow is manual and disconnected from git. Users must remember session IDs, manage DS URLs, and manually coordinate git branches.

## Project location

`sesh` is a new project inside `examples/sesh/` in the durable-streams repo. It builds on the cods prototype (`examples/cc-live-share/`) but is a fresh implementation with a clean design. It uses `@durable-streams/client` for DS operations.

## Goal

Seamlessly integrate CC session management with git. Sessions are tracked in a per-repo index, persisted to Durable Streams at commit time, and discoverable by anyone who checks out the branch. Resuming a session is a single command.

The model follows git conventions:

- **Sessions are opt-in** — explicitly check in which sessions to track
- **Sessions are immutable** — resuming forks the session (new ID, references parent)
- **One file per session** — no merge conflicts when multiple people add sessions
- **Offsets at each commit** — enables time travel (resume from any commit)

## Non-goals

- Real-time session streaming (use cods `share`/`follow` for that)
- Automatic persistence of all sessions (explicit opt-in only)
- Multi-agent support in initial phases (future research)

---

## Concepts

### Session index

A `.sesh/` directory at the repo root, checked into git:

```
.sesh/
  config.json                    # DS server URL, auth settings
  sessions/
    <session-id-1>.json          # one file per checked-in session
    <session-id-2>.json
  .local/                        # gitignored, per-machine state
    <session-id-1>.json          # local push state (lastPushedUuid)
```

### Session file (checked into git)

```json
{
  "sessionId": "abc123-...",
  "parentSessionId": null,
  "streamUrl": "https://ds.example.com/sessions/abc123-...",
  "lastOffset": "0000000000000000_0000000000004567",
  "name": "auth-refactor",
  "cwd": "src/auth",
  "agent": "claude",
  "createdBy": "alice",
  "forkedFromOffset": null
}
```

For a forked session:

```json
{
  "sessionId": "def456-...",
  "parentSessionId": "abc123-...",
  "streamUrl": "https://ds.example.com/sessions/def456-...",
  "lastOffset": "0000000000000000_0000000000006789",
  "name": "auth-refactor-continued",
  "cwd": "src/auth",
  "agent": "claude",
  "createdBy": "bob",
  "forkedFromOffset": "0000000000000000_0000000000002345"
}
```

### Local state file (gitignored)

```json
{
  "lastPushedUuid": "e0cb6253-aa2f-435c-a0a4-aea65af95193"
}
```

### Config file (checked into git)

```json
{
  "server": "https://ds.example.com",
  "version": 1
}
```

Auth token is NOT checked into git. Stored in:

- Environment variable `SESH_TOKEN`
- Or `~/.sesh/credentials.json` (per-user global config)

---

## Phases

### Phase 1: Core CLI + manual workflow

The foundation. All operations are manual CLI commands. No hooks, no skills.

#### Commands

**`sesh init --server <url> [--token <token>]`**

Initialize sesh for a repo. Creates `.sesh/config.json` and `.sesh/.local/` (with `.gitignore`).

```bash
$ sesh init --server https://ds.example.com
Initialized sesh in /path/to/repo
  Config: .sesh/config.json
  Add .sesh/ to your git repo: git add .sesh/config.json
```

If `--token` is provided, stores it in `~/.sesh/credentials.json` (not in the repo).

**`sesh checkin [--session <id>] [--name <name>]`**

Mark a CC session for tracking. Adds it to `.sesh/sessions/`.

- If `--session` is omitted, auto-detects the active session in the current directory (same logic as cods: scan `~/.claude/sessions/*.json` for matching cwd + alive pid).
- If multiple sessions found, prompt the user to choose.
- `--name` sets a human-readable name. If omitted, uses CC's session slug if available.

```bash
$ sesh checkin
Detected session: curious-munching-clarke (47515c25-...)
Checked in as: .sesh/sessions/47515c25-....json

$ sesh checkin --session abc123 --name "auth work"
Checked in as: .sesh/sessions/abc123.json
```

The session file is created with `lastOffset: null` and `streamUrl: null` (populated on first push).

**`sesh push`**

Walk all checked-in sessions, push new content to DS, update offsets.

For each session in `.sesh/sessions/`:

1. Find the local JSONL at `~/.claude/projects/{encoded-cwd}/{session-id}.jsonl`
2. If JSONL doesn't exist locally, skip (it's someone else's session)
3. Read `.sesh/.local/<session-id>.json` to get `lastPushedUuid`
4. Scan JSONL backwards from end. Stop at `lastPushedUuid` or a `compact_boundary` (whichever comes first). If neither found, start from beginning.
5. If `streamUrl` is null, create a new DS stream
6. Push entries from the identified start point to the end of the file
7. Update `lastOffset` in the session file (from DS response)
8. Update `lastPushedUuid` in the local state file
9. Stage the updated session file for the commit

```bash
$ sesh push
Pushing sessions...
  47515c25: 12 new entries → offset 0000000000000000_0000000000004567
  def456:   skipped (not local)
Done. Session files updated — remember to commit.
```

**`sesh list`**

Show all checked-in sessions on the current branch.

```bash
$ sesh list
Sessions:
  47515c25  "auth-refactor"         by alice  cwd: src/auth     agent: claude  offset: ...4567
  def456    "rate-limiting"         by bob    cwd: src/api      agent: claude  offset: ...2345
    └── ghi789  "rate-limiting-v2"  by carol  cwd: src/api      agent: claude  (forked from def456)
```

Shows lineage (parent → child) via indentation.

**`sesh resume [<session-id>] [--no-checkin]`**

Fork a session from the index and create a local CC session.

- If `<session-id>` omitted and only one session exists, use it. If multiple, prompt the user to choose.
- Reads DS stream from the last compaction checkpoint (via `offset=compact`) up to `lastOffset`
- Creates a new local CC session (fork with new ID)
- Creates `.sesh/sessions/<new-id>.json` with `parentSessionId` and `forkedFromOffset`
- If `--no-checkin`, skips creating the session file (session is local only)

```bash
$ sesh resume 47515c25
Forking session "auth-refactor" by alice...
  Reading from DS (from compaction checkpoint to offset ...4567)
  Created local session: ghi789
  Checked in as: .sesh/sessions/ghi789.json

Resume with: cd src/auth && claude --continue
```

#### Phase 1 deliverables

| #   | Deliverable    | Description                                   |
| --- | -------------- | --------------------------------------------- |
| 1   | `sesh init`    | Create `.sesh/` config                        |
| 2   | `sesh checkin` | Add session to index                          |
| 3   | `sesh push`    | Push session deltas to DS, update offsets     |
| 4   | `sesh list`    | List sessions with lineage                    |
| 5   | `sesh resume`  | Fork session from DS, create local CC session |

---

### Phase 2: Git integration + time travel

Add pre-commit hook for automatic pushing and enable time travel.

**`sesh install-hooks`**

Install a git pre-commit hook that runs `sesh push` automatically.

```bash
$ sesh install-hooks
Installed pre-commit hook: .git/hooks/pre-commit
Sesh will automatically push session data on each commit.
```

The hook:

1. Runs `sesh push`
2. Stages any updated `.sesh/sessions/*.json` files
3. The commit proceeds with the updated offsets

**Time travel: `sesh resume <session-id> --at <commit>`**

Resume a session from a specific point in history.

1. Read `.sesh/sessions/<session-id>.json` from the specified commit: `git show <commit>:.sesh/sessions/<session-id>.json`
2. Get the `lastOffset` at that commit
3. Read the DS stream. If the compaction checkpoint offset is before the target offset, read from checkpoint to target offset. Otherwise read from the beginning to the target offset.
4. Create a local CC session from those entries
5. Check it in with `forkedFromOffset` pointing to that historical offset

```bash
$ sesh resume auth-session --at HEAD~5
Forking session "auth-refactor" at commit abc1234...
  Offset at that commit: ...2345
  Reading from DS (start to ...2345)
  Created local session: xyz789

Resume with: cd src/auth && claude --continue
```

#### Phase 2 deliverables

| #   | Deliverable                    | Description                           |
| --- | ------------------------------ | ------------------------------------- |
| 1   | `sesh install-hooks`           | Install pre-commit hook               |
| 2   | Pre-commit hook                | Auto-runs `sesh push`, stages updates |
| 3   | `--at <commit>` flag on resume | Time travel to any commit             |

---

### Phase 3: Skills + convenience

CC skills that wrap the CLI commands.

**`/checkin`** — marks the current session for tracking.

**`/resume`** — may not make sense as a skill since you'd need to exit and start a new session. Could instead list available sessions and give the user the command to run.

```
/checkin
→ Claude runs: sesh checkin --session ${CLAUDE_SESSION_ID}
→ "Session checked in. It will be pushed to DS on your next commit."
```

#### Phase 3 deliverables

| #   | Deliverable          | Description                              |
| --- | -------------------- | ---------------------------------------- |
| 1   | `/checkin` skill     | Wraps `sesh checkin`                     |
| 2   | Improved `sesh list` | Lineage display, filtering by user/agent |

---

### Phase 4: Session merge

Merge two sessions that diverged from the same parent.

**`sesh merge <session-id-A> <session-id-B>`**

Same mechanics as cods merge:

- Git merge of the two sessions' code branches
- Agent-assisted conflict resolution with session context
- Merged session with combined context from both branches
- New session file with both parents referenced

#### Phase 4 deliverables

| #   | Deliverable                        | Description                          |
| --- | ---------------------------------- | ------------------------------------ |
| 1   | `sesh merge`                       | Merge two local sessions             |
| 2   | Agent-assisted conflict resolution | Summaries + agent resolves conflicts |
| 3   | Merged session creation            | Combined context from both branches  |

---

### Phase 5: Multi-agent support (future research)

Support coding agents beyond Claude Code (Codex, Cursor, etc.).

- Agent adapter interface for push/restore
- Agent-agnostic session file format (already in place via `agent` field)
- Per-agent session discovery (each agent stores sessions differently)

**Not implementable right now — requires more research into other agents' session formats and storage mechanisms.**

---

## Resolved questions

1. **One stream per session** — maps to how CC works, clean offsets per session.
2. **Persist on commit** — matches git model, sessions only matter at commit boundaries.
3. **Explicit opt-in** — `sesh checkin` marks sessions for tracking. Not all sessions are persisted.
4. **Per-repo config** — `sesh init` sets DS server URL, checked into git. Token stored per-user.
5. **One file per session** — eliminates merge conflicts. Sessions are immutable once checked in.
6. **Resuming = forking** — creates new session with parent reference. Original stays read-only.
7. **Lineage tracking** — `parentSessionId` + `forkedFromOffset` enables full traceability.
8. **Delta push via UUID** — scan backwards to `lastPushedUuid` or compaction boundary. No byte offsets.
9. **Local state gitignored** — `.sesh/.local/` tracks push state per-machine.
10. **Raw agent-specific format** — DS streams contain raw CC JSONL. Agent field enables future adapters.

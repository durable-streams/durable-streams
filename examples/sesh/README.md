# sesh — Git-integrated CC session management via Durable Streams

Share, discover, and resume Claude Code sessions across machines and teammates via git.

Sessions are tracked in a `.sesh/` directory in your repo, persisted to Durable Streams at commit time, and discoverable by anyone who checks out the branch.

## Quick start

### 1. Start a DS server

```bash
# Local dev server (from the durable-streams repo)
cd examples/cc-live-share && npx tsx server.ts
```

### 2. Initialize sesh in your repo

```bash
cd /path/to/your/repo
sesh init --server http://127.0.0.1:4437
git add .sesh/
git commit -m "init sesh"
```

### 3. Check in a session

Start a CC session, do some work, then check it in:

```bash
sesh checkin                          # auto-detects active session
sesh checkin --session <session-id>   # or specify explicitly
```

### 4. Push to DS

```bash
sesh push
git add .sesh/
git commit -m "push session"
git push
```

### 5. Resume on another machine

```bash
git clone <repo> && cd <repo>
git checkout <branch>
sesh list                                  # see available sessions
sesh resume <session-id-or-name>           # fork and restore the session
claude --resume <new-session-id>           # start CC with the restored session
```

## Commands

### `sesh init --server <url> [--token <token>]`

Initialize sesh for a repo. Creates `.sesh/config.json` with the DS server URL. Token is stored in `~/.sesh/credentials.json` (not checked into git). Can also be set via `SESH_TOKEN` env var.

### `sesh checkin [--session <id>] [--name <name>]`

Mark a CC session for tracking. Auto-detects the active session if `--session` is omitted. If the session isn't active, reads the cwd from the session's JSONL file.

The session is added to `.sesh/sessions/<session-id>.json` and will be persisted to DS on each `sesh push`.

### `sesh push`

Push all checked-in sessions to DS. For each session:

1. Finds the local JSONL file
2. Determines what's new (scans backwards for the last pushed UUID or a compaction boundary)
3. Pushes the delta to the DS stream
4. Updates the session file with the new offset

Only pushes sessions that exist locally — skips sessions from other teammates.

### `sesh list`

Show all tracked sessions with lineage (parent → child relationships).

```
Sessions:
7fe1783d-...  "auth-refactor"         by alice  cwd: ./src/auth     agent: claude  offset: ...4567
  └── abc123-...  "auth-refactor (resumed)"  by bob  cwd: ./src/auth  agent: claude  not pushed
```

### `sesh resume [<session-id>] [--no-checkin] [--at <commit>]`

Fork a session from DS and create a local CC session.

- Accepts full session ID or session name
- If only one session exists, auto-selects it
- Reads from the DS stream (from the last compaction checkpoint)
- Creates a new session with a new ID, referencing the parent
- Automatically checks in the new session (use `--no-checkin` to skip)

### `sesh merge <session-A> <session-B>`

Merge two local sessions. Uses git merge for code and agent-assisted conflict resolution. Creates a merged session with combined context from both branches.

### `sesh install-hooks`

Install a git pre-commit hook that runs `sesh push` automatically on every commit. Session offsets are recorded at each commit point.

### `sesh install-skills [--global]`

Install the `/checkin` skill for Claude Code. With `--global`, installs to `~/.claude/skills/` (available in all projects).

## Time travel

Every commit records the DS offset for each session. You can resume a session from any point in history.

### Resume from a specific commit

```bash
# Find commits that updated sessions
git log --format="%H %s" -- .sesh/sessions/

# Resume from an earlier commit
sesh resume <session-id> --at <commit-hash>
claude --resume <new-session-id>
```

The session is restored with only the entries that existed at that commit — later messages are excluded.

### Natural git workflow

You can also just checkout the commit and resume normally:

```bash
git checkout <commit-hash>
sesh resume <session-id>
claude --resume <new-session-id>
```

Since the session file at that commit has the offset from that point in time, resume automatically gets the right entries.

## How it works

### Session index (`.sesh/`)

```
.sesh/
  config.json                    # DS server URL (checked into git)
  sessions/
    <session-id>.json            # one file per session (checked into git)
  .local/                        # gitignored
    <session-id>.json            # local push state (lastPushedUuid)
```

### Session file format

```json
{
  "sessionId": "7fe1783d-...",
  "parentSessionId": null,
  "streamUrl": "http://ds.example.com/sesh/7fe1783d-...",
  "lastOffset": "0000000000000000_0000000000004567",
  "entryCount": 22,
  "name": "auth-refactor",
  "cwd": "./src/auth",
  "agent": "claude",
  "createdBy": "alice",
  "forkedFromOffset": null
}
```

### Key design decisions

- **One file per session** — no merge conflicts when multiple people add sessions
- **Sessions are immutable** — resuming creates a fork (new ID, references parent)
- **Explicit opt-in** — only checked-in sessions are tracked
- **Delta push** — only new entries are pushed on each commit, tracked via UUID
- **Config server URL** — resume always uses the current config, not the stored URL (so sessions work across different environments)

## Remote testing

To test across machines, make the DS server reachable:

```bash
# On the machine running the DS server
ngrok http 4437
```

Update the config in the repo to use the ngrok URL:

```bash
sesh init --server https://your-ngrok-url.ngrok.io
sesh push
git add .sesh/ && git commit -m "update DS server URL" && git push
```

On the remote machine:

```bash
git pull
sesh list
sesh resume <session-id>
claude --resume <new-session-id>
```

## Running tests

```bash
cd examples/sesh

# Phase 1: core CLI (init, checkin, push, list, resume)
npx tsx test/e2e-phase1.ts

# Phase 2: git hooks + time travel
npx tsx test/e2e-phase2.ts

# Phase 4: merge
npx tsx test/e2e-phase4.ts
```

# ds-cc: Claude Code session sharing via Durable Streams

A CLI tool for sharing, following, forking, and cloning Claude Code sessions using Durable Streams.

## Setup

From the `examples/cc-live-share` directory:

```bash
pnpm install
```

All commands are run with `npx tsx src/cli.ts` (or `pnpm dev` for help).

## Commands

### Live sharing (Phase 1)

Share a CC session in real-time. Others can watch the conversation unfold as it happens.

#### Start the DS server

```bash
npx tsx server.ts
```

Starts a DS dev server on `http://127.0.0.1:4437` with checkpoint rules configured for CC compaction boundaries.

Options:

- `--port <port>` — default: 4437
- `--data-dir <path>` — enable file-backed storage (default: in-memory)

#### Share a session

```bash
npx tsx src/cli.ts share --server http://127.0.0.1:4437
```

Auto-detects the active CC session and streams it to the DS server. Prints a stream URL to share.

Options:

- `--session <id>` — specify a session ID (skips auto-detect)
- `--server <url>` — DS server URL (required)

#### Follow a session

```bash
npx tsx src/cli.ts follow http://127.0.0.1:4437/cc/<session-id>
```

Connects to a shared session and renders it in the terminal. Catches up from the last compaction checkpoint, then live-tails via SSE.

Options:

- `--from-beginning` — read from the start instead of the checkpoint

### Fork and clone (Phase 2)

Fork a CC session and resume it on any machine. Each clone works independently with its own session ID and git branch.

#### Fork (export) a session

```bash
npx tsx src/cli.ts fork --server http://127.0.0.1:4437
```

Exports the current CC session:

1. Writes the session JSONL to a DS stream (from last compaction boundary)
2. Creates a git branch with the full working state (including uncommitted changes)
3. Pushes the branch to the remote

The working directory is completely untouched — uses git plumbing to create the branch without switching or stashing.

Each fork gets a unique branch name (`cc-session/{session-id}/{epoch}`) so you can fork the same session multiple times at different points in time.

Options:

- `--session <id>` — specify a session ID (skips auto-detect)
- `--server <url>` — DS server URL (required)
- `--remote <name>` — git remote to push to (default: `origin`)

#### Clone (import) a forked session

```bash
npx tsx src/cli.ts clone <fork-url>
```

Imports a forked session from a DS stream and sets up a local working environment.

**Code setup** — the clone command auto-detects whether you're already inside the matching git repo:

- **Inside the repo:** creates a git worktree (isolated from your current work)
- **Not in the repo:** does a fresh `git clone`

**Session setup** — two modes for creating the local CC session:

- **Default mode:** uses `claude -c --fork-session` to let CC create the session internally. This is slower (~3s, makes an API call with Haiku) but resilient to future CC format changes. Requires `claude` CLI to be installed.
- **Fast mode (`--fast`):** manually rewrites the JSONL fields (`cwd`, `sessionId`, `gitBranch`) and writes the session directly. Instant, but coupled to CC's internal JSONL structure. Use this if CC's `--fork-session` is unavailable, or for speed when you know the JSONL format hasn't changed.

Options:

- `--resume` — automatically start CC after cloning (`claude --continue`)
- `--fast` — use manual JSONL rewriting instead of `claude --fork-session`

After cloning, start the session:

```bash
cd ./session-<short-id> && claude --continue
```

## Testing locally

### Live sharing

Open 3 terminals, all from `examples/cc-live-share`:

```bash
# Terminal 1: DS server
npx tsx server.ts

# Terminal 2: share your current CC session
npx tsx src/cli.ts share --server http://127.0.0.1:4437

# Terminal 3: follow the shared session (use the URL from terminal 2)
npx tsx src/cli.ts follow http://127.0.0.1:4437/cc/<session-id>
```

### Fork and clone (with local git remote)

To test without pushing to a real remote:

```bash
# One-time setup: create a local bare repo as a "remote"
git clone --bare /path/to/your/repo /tmp/ds-test-remote.git
cd /path/to/your/repo
git remote add test-local /tmp/ds-test-remote.git
```

```bash
# Terminal 1: DS server
cd examples/cc-live-share
npx tsx server.ts

# Terminal 2: fork the session
cd examples/cc-live-share
npx tsx src/cli.ts fork --server http://127.0.0.1:4437 --remote test-local
```

Clone from inside the repo (worktree mode):

```bash
cd /path/to/your/repo
npx tsx examples/cc-live-share/src/cli.ts clone <fork-url>
# Creates ./session-<short-id> as a worktree
```

Clone from anywhere (fresh clone mode):

```bash
cd /tmp
npx tsx /path/to/examples/cc-live-share/src/cli.ts clone <fork-url>
# Clones the repo into ./session-<short-id>
```

Clone with fast mode:

```bash
npx tsx /path/to/examples/cc-live-share/src/cli.ts clone --fast <fork-url>
```

Then resume the session:

```bash
cd ./session-<short-id>
claude --continue
```

Or clone and resume in one step:

```bash
npx tsx /path/to/examples/cc-live-share/src/cli.ts clone --resume <fork-url>
```

Cleanup:

```bash
cd /path/to/your/repo
git remote remove test-local
rm -rf /tmp/ds-test-remote.git
```

## Running the automated tests

```bash
# Phase 1 e2e test (uses a real CC session file)
cd examples/cc-live-share
npx tsx test/e2e.ts

# Phase 2 e2e test (creates temporary git repos, tests git + DS mechanics)
npx tsx test/e2e-phase2.ts

# Checkpoint unit tests
cd ../..
npx vitest run --project server test/checkpoints.test.ts
```

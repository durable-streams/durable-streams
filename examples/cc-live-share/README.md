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

Options:

- `--session <id>` — specify a session ID (skips auto-detect)
- `--server <url>` — DS server URL (required)
- `--remote <name>` — git remote to push to (default: `origin`)

#### Clone (import) a forked session

```bash
npx tsx src/cli.ts clone <fork-url>
```

Imports a forked session from a DS stream:

1. Reads the fork metadata (repo URL, branch, original cwd)
2. Fetches the code (auto-detects the best method, see below)
3. Rewrites the JSONL for the local environment (cwd, session ID, git branch)
4. Writes the JSONL to `~/.claude/projects/` so CC can find it

**Auto-detection:** the clone command detects whether you're already inside the matching git repo:

- **Inside the repo:** creates a git worktree (isolated from your current work)
- **Not in the repo:** does a fresh `git clone`

Options:

- `--resume` — automatically start CC after cloning (`claude --continue`)

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
npx tsx examples/cc-live-share/src/cli.ts clone http://127.0.0.1:4437/cc/<session-id>
# Creates ./session-<short-id> as a worktree
```

Clone from anywhere (fresh clone mode):

```bash
mkdir /tmp/test-clone && cd /tmp/test-clone
npx tsx /path/to/examples/cc-live-share/src/cli.ts clone http://127.0.0.1:4437/cc/<session-id>
# Clones the repo into ./session-<short-id>
```

Then resume the session:

```bash
cd ./session-<short-id>
claude --continue
```

Cleanup:

```bash
cd /path/to/your/repo
git remote remove test-local
rm -rf /tmp/ds-test-remote.git /tmp/test-clone
```

## Running the automated tests

```bash
# Phase 1 e2e test (uses a real CC session file)
cd examples/cc-live-share
npx tsx test/e2e.ts

# Phase 2 e2e test (creates temporary git repos)
npx tsx test/e2e-phase2.ts

# Checkpoint unit tests
cd ../..
npx vitest run --project server test/checkpoints.test.ts
```

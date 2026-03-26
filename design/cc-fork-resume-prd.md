# PRD: CC session fork and resume (Phase 2)

**Status:** Draft
**Date:** 2026-03-26
**Authors:** Kevin, Claude
**Depends on:** Phase 1 (CC live session sharing)

---

## Problem

Phase 1 enables read-only live sharing of CC sessions. But viewers can only watch — they can't take over, continue the work, or branch off in a new direction.

Teams need the ability to fork a CC session, resume it on another machine, and work independently — like forking a git branch.

## Goal

Enable users to fork a CC session and resume it on any machine with the same codebase. Each fork works independently with its own session ID and git branch.

The model is git-like: fork from a point, diverge independently, merge later (Phase 3).

## Non-goals (Phase 2)

- **Merging sessions** — forked sessions diverge independently; merging back is Phase 3
- **Live collaboration** — no concurrent editing of the same session
- **CC native integration** — standalone CLI tool, no `/fork` slash command yet
- **Non-git working directories** — assumes the working directory is a git repository
- **Authentication** — assumed at the infrastructure layer

## User experience

### Forking (exporting) a session

```
$ ds-cc fork --server https://ds.example.com
Detected active session: curious-munching-clarke (47515c25-...)

Exporting session to Durable Stream...
  Session stream: https://ds.example.com/cc/47515c25-.../session
  Metadata stream: https://ds.example.com/cc/47515c25-.../meta
  Wrote 23 JSONL entries (from compaction boundary)

Pushing code state to git...
  Created branch: cc-session/47515c25-...
  Committed 3 modified files, 1 untracked file
  Pushed to origin

Fork URL: https://ds.example.com/cc/47515c25-d702-4c25-b772-a2147aa63f56

Share this URL. Others can clone it with:
  ds-cc clone https://ds.example.com/cc/47515c25-d702-4c25-b772-a2147aa63f56
```

The command:

1. Locates the active CC session (same auto-detect as Phase 1)
2. Creates two DS streams: one for the JSONL session data, one for fork metadata
3. Writes JSONL entries from the last compaction boundary to the session stream
4. Stashes local changes, creates a git branch with the full working state, pushes it, restores local state
5. Writes fork metadata (repo URL, branch name, original cwd) to the metadata stream
6. Prints the fork URL

### Cloning (importing) a forked session

```
$ ds-cc clone https://ds.example.com/cc/47515c25-d702-4c25-b772-a2147aa63f56
Reading fork metadata...
  Repo: git@github.com:electric-sql/myproject.git
  Branch: cc-session/47515c25-...
  Original cwd: /Users/alice/projects/myproject

Fetching code...
  git fetch origin cc-session/47515c25-...
  Created worktree at ./session-47515c25 on branch cc-session/a1b2c3d4-...

Restoring CC session...
  New session ID: a1b2c3d4-...
  Wrote 23 JSONL entries to ~/.claude/projects/-Users-kevin-...-session-47515c25/a1b2c3d4-....jsonl

Ready! Start the session with:
  cd ./session-47515c25 && claude --continue
```

The command:

1. Reads the metadata stream to get repo URL, branch name, and original cwd
2. **Auto-detects** whether the current directory is inside the matching git repo:
   - **If inside the repo**: fetches the export branch and creates a git worktree on a new clone branch (isolated from the user's current work)
   - **If not in the repo** (or not in a git repo at all): does a fresh `git clone` of the repo and checks out the clone branch
3. Reads the JSONL session stream and writes it as-is to `~/.claude/projects/{encoded-original-cwd}/{original-session-id}.jsonl` (no rewriting)
4. Uses `claude -r <original-session-id> --fork-session` from the clone directory to let CC create a properly forked session with a new ID and the correct cwd
5. Cleans up the temporary original JSONL file
6. Prints the command to resume the session

**Why `--fork-session`:** CC's own forking logic handles all the internal details — new session ID, cwd update, git branch, etc. This avoids relying on CC's internal JSONL structure and is resilient to format changes.

### Resuming the cloned session

With `--resume`, the clone command starts CC automatically after forking:

```
$ ds-cc clone --resume https://ds.example.com/cc/47515c25-...
...
Restoring CC session...
Forking session via CC...
Starting Claude Code...
```

Without `--resume`, the user starts CC manually. This is useful when they want to pass additional CC flags:

```
$ cd ./session-47515c25 && claude --continue --dangerously-skip-permissions
```

---

## Technical design

### Two DS streams per fork

Each fork creates two streams at the DS server:

| Stream   | URL                                | Content                                | Purpose                           |
| -------- | ---------------------------------- | -------------------------------------- | --------------------------------- |
| Session  | `{server}/cc/{session-id}/session` | JSONL entries from compaction boundary | The conversation state            |
| Metadata | `{server}/cc/{session-id}/meta`    | Single JSON message                    | Fork metadata (repo, branch, cwd) |

Separating metadata from session data avoids the problem of needing to read from both the beginning (metadata) and the checkpoint (session data) of the same stream.

#### Metadata format

```json
{
  "type": "fork-metadata",
  "version": 1,
  "sessionId": "47515c25-d702-4c25-b772-a2147aa63f56",
  "repo": "git@github.com:electric-sql/myproject.git",
  "branch": "cc-session/47515c25-d702-4c25-b772-a2147aa63f56",
  "originalCwd": "/Users/alice/projects/myproject",
  "createdAt": "2026-03-26T12:00:00Z"
}
```

#### Session stream

Identical to Phase 1: raw JSONL entries from the last compaction boundary. Uses the `compact` checkpoint for efficient late-joining reads.

### Git operations

#### Export (fork)

The fork command creates a git branch that captures the exact working state of the exporter's machine — including uncommitted changes and untracked files (respecting .gitignore).

```
1. git stash --include-untracked          # save all local state
2. git checkout -b cc-session/{session-id} # create export branch
3. git stash apply                         # restore changes on export branch
4. git add -A                              # stage everything (respects .gitignore)
5. git commit -m "CC session fork: {session-id}"
6. git push origin cc-session/{session-id} # push to shared remote
7. git checkout {original-branch}          # go back
8. git stash pop                           # restore original working state
```

After this sequence, the user's working directory is exactly as it was before. The export branch exists on the remote with the full working state committed.

**Edge cases:**

- If there are no local changes, steps 1 and 7-8 can be skipped (just create branch from HEAD, push)
- If `git stash` fails (nothing to stash), continue without it
- If `git push` fails (no remote access), error with a clear message

#### Import (clone)

The clone command auto-detects whether the user is inside the matching repo by checking if any remote URL matches the fork metadata's repo URL.

**If inside the repo** (worktree mode):

```
1. git fetch origin cc-session/{original-session-id}
2. git worktree add ./session-{short-id} -b cc-session/{new-session-id} origin/cc-session/{original-session-id}
```

- Fetches the export branch without affecting the user's current checkout
- Creates a worktree at `./session-{short-id}` on a new clone branch
- Multiple clones can coexist as separate worktrees

**If not in the repo** (fresh clone mode):

```
1. git clone {repo-url} ./session-{short-id}
2. git checkout cc-session/{original-session-id}
3. git checkout -b cc-session/{new-session-id}
```

- Clones the entire repo into `./session-{short-id}`
- Checks out the export branch, then creates the clone branch from it
- No worktree needed since the clone is standalone

**In both cases:** each clone gets its own branch `cc-session/{new-session-id}` so they can commit independently. The original export branch stays untouched as the common ancestor for Phase 3 merging.

### Detecting the git remote URL

The fork command needs to know the remote URL to store in metadata. It uses:

```
git remote get-url origin
```

If the repo has no `origin` remote, or has multiple remotes, the user can specify:

```
ds-cc fork --remote upstream --server https://ds.example.com
```

### JSONL rewriting on import

CC's JSONL entries contain path-sensitive fields that need updating for the clone's local environment:

| Field       | Original value                    | Rewritten to                                 |
| ----------- | --------------------------------- | -------------------------------------------- |
| `cwd`       | `/Users/alice/projects/myproject` | `/Users/bob/code/myproject/session-47515c25` |
| `sessionId` | `47515c25-...`                    | `a1b2c3d4-...` (new UUID)                    |
| `gitBranch` | `main`                            | `cc-session/clone-a1b2c3d4`                  |

The rewriting is a simple string replacement on each JSONL line before writing to disk.

The rewritten JSONL is placed at:

```
~/.claude/projects/{encoded-clone-cwd}/{new-session-id}.jsonl
```

**Why manual rewriting (not `--fork-session`):** CC's `--fork-session` flag only works with sessions CC itself created on the local machine. For cross-machine cloning, the session doesn't exist in CC's index, so we must write the JSONL directly. `--fork-session` is used in Phase 3 for querying existing local sessions.

---

## Relationship to Phase 1

Phase 2 reuses Phase 1 infrastructure:

- Same DS server with checkpoint rules
- Same JSONL writing logic (from compaction boundary, with sanitization)
- Same stream URL convention (`/cc/{session-id}/...`)

The key differences:

- Phase 1 is a live sidecar (continuous tailing); Phase 2 is a one-shot export
- Phase 1 has one stream; Phase 2 has two (session + metadata)
- Phase 2 adds git operations (branch, push, fetch, worktree)
- Phase 2 adds JSONL rewriting for path adaptation

The `ds-cc share` and `ds-cc follow` commands from Phase 1 continue to work independently.

---

## Deliverables

| #   | Deliverable                 | Description                                                     |
| --- | --------------------------- | --------------------------------------------------------------- |
| 1   | **`ds-cc fork` command**    | Exports CC session to DS + pushes git branch with working state |
| 2   | **`ds-cc clone` command**   | Imports session from DS + sets up worktree + rewrites JSONL     |
| 3   | **Metadata stream support** | Separate `/meta` stream for fork metadata                       |
| 4   | **JSONL rewriter**          | Rewrites cwd, sessionId, gitBranch in JSONL entries             |
| 5   | **Git operations module**   | Plumbing-based export, fetch/worktree/clone for import          |

### Ordering

1. **Git operations** (deliverable 5) — core mechanics, testable independently
2. **JSONL rewriter** (deliverable 4) — pure function, easy to unit test
3. **Fork command** (deliverables 1, 3) — combines DS write + git export
4. **Clone command** (deliverable 2) — combines DS read + git import + JSONL rewrite

---

## Resolved questions

1. **Branch naming** — export branch is `cc-session/{original-session-id}`. Clone branches are `cc-session/{clone-session-id}`.

2. **Metadata location** — separate DS stream at `{server}/cc/{session-id}/meta`, not mixed into the session stream.

3. **Working directory transfer** — git branch (not zip). Assumes git repo + shared remote access. Enables Phase 3 merging with git history.

4. **Clone isolation** — each clone gets its own branch immediately, forked from the export branch. The export branch is the untouched common ancestor.

5. **Worktree location** — `./session-{short-id}` in the current directory. The user can specify a custom path later if needed.

6. **Dirty state** — the fork command commits all working changes (staged, unstaged, untracked respecting .gitignore). A warning is printed about what's being committed.

7. **Session IDs** — the export keeps the original session ID (it's exporting _this_ session). Each clone generates a new UUID (so clones are distinguishable in Phase 3).

---

## Future: Phase 3 (merging)

Phase 3 builds on Phase 2's git branch model:

- The export branch is the common ancestor (merge base)
- Each clone's branch has its own divergent history
- `ds-cc merge` combines a clone branch back into a target session
- Code merge: `git merge` with the clone branch (agents resolve conflicts)
- Session merge: agent-assisted reconciliation of JSONL histories from divergent sessions

The git branch structure from Phase 2 directly enables this:

```
cc-session/{original-id}          ← export snapshot (common ancestor)
  ├── cc-session/{clone-1-id}     ← Bob's work
  └── cc-session/{clone-2-id}     ← Carol's work
```

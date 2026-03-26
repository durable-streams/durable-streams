# PRD: CC session merge (Phase 3)

**Status:** Draft
**Date:** 2026-03-26
**Authors:** Kevin, Claude
**Depends on:** Phase 2 (CC session fork and clone)

---

## Problem

Phase 2 enables forking CC sessions and working independently. But forked sessions eventually need to be brought back together — the code changes need to be merged and Claude needs to understand what happened in both branches.

## Goal

Merge a forked CC session back, combining both the code (via git merge) and the conversation context (via a summary of both sessions' work). The result is a new CC session that has the original context, knows what both branches did, and has the merged code.

## Non-goals (Phase 3)

- **Real-time collaborative editing** — this is offline merge, not live collaboration
- **Automatic conflict resolution without agent** — an agent (Claude) resolves conflicts
- **JSONL-level merge** — we don't diff/merge individual JSONL entries; we summarize
- **Three-way merge of arbitrary sessions** — merge is pairwise (one fork into one target)

## User experience

### Merging a forked session

```
$ ds-cc merge <fork-url> --into <target-session-or-branch>
Fetching session summaries...
  Session A (fork): "Refactored auth middleware to use JWT, added token validation tests"
  Session B (target): "Added rate limiting to API endpoints, updated OpenAPI spec"

Merging code...
  git merge cc-session/abc123 into cc-session/def456
  1 conflict in src/middleware.ts
  Resolving conflicts with agent...
  Agent resolved 1 conflict (kept both changes)
  Committed merge

Creating merged session...
  New session ID: merged-789...
  Context: original session + summaries of both branches + merge notes

Ready! Start the merged session with:
  cd ./session-merged-789 && claude --continue
```

### Simple case (no conflicts)

```
$ ds-cc merge <fork-url> --into <target-session-or-branch>
Fetching session summaries...
Merging code...
  Clean merge, no conflicts.
Creating merged session...

Ready! Start the merged session with:
  cd ./session-merged-789 && claude --continue
```

---

## Technical design

### Merge flow

```
                    ┌─────────────────┐
                    │  1. Summarize   │
                    │  both sessions  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  2. Git merge   │
                    │  (agent resolves│
                    │   conflicts     │
                    │   using         │
                    │   summaries)    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  3. Create      │
                    │  session C from │
                    │  original JSONL │
                    │  + summaries    │
                    └─────────────────┘
```

### Step 1: Generate session summaries

For each session being merged, the tool generates a natural-language summary of what that session accomplished. The summary is obtained by querying the session itself using CC's `--fork-session` flag:

```bash
claude -r <session-id> --fork-session -p "Summarize what you did since the fork point (branch cc-session/{original-id}). Include key decisions, what was changed, and why. Be concise (3-5 sentences)."
```

This resumes the session in print mode with `--fork-session` so the original session is untouched. The session has full context of its own work, so it can produce an accurate summary without us needing to parse or feed it the JSONL.

**Output:** a short summary like "Refactored the auth middleware from session cookies to JWT tokens. Added token validation and refresh logic. Updated 5 test files to use the new auth flow."

Both summaries are generated before the merge begins, since they're used in both the code merge (step 2) and the session creation (step 3).

### Step 2: Git merge with agent-assisted conflict resolution

The code merge uses standard git:

```
git merge cc-session/{fork-id} --no-commit
```

**If clean merge:** commit and proceed to step 3.

**If conflicts:** invoke an agent (CC) in the merged worktree with the session summaries. The agent finds and resolves conflicts itself — it can read the conflicted files, run `git status`, `git diff`, `git log`, etc. The summaries give it the _intent_ behind each branch's changes so it can make informed merge decisions.

The agent prompt is simply:

```
Two branches of work are being merged and there are conflicts.

Branch A did: [summary A]
Branch B did: [summary B]

Please resolve all merge conflicts in the working directory.
Use git status to find conflicted files and resolve them.
```

The agent resolves each conflict, stages the files, and commits the merge.

### Step 3: Create the merged session

The merged session C is constructed from:

The merged session C is created by forking the original session and extending it with a merge context message. The context message is richer than just the summaries used for conflict resolution — it includes the compacted contexts from both sessions so Claude retains as much detail as possible.

**Getting compacted contexts:** for each session (A and B), query the session using `--fork-session`:

```bash
claude -r <session-id> --fork-session -p "Give me a detailed summary of everything in this session — all key context, decisions, changes made, and current state. This will be used to create a merged session."
```

**Creating the merged session:**

1. Fork the original session using `claude -r <original-session-id> --fork-session` in the merged worktree directory. This gives session C the full original context with the correct cwd.
2. Send a message to session C with the combined context:

```
Two branches of work have been merged into this session.

Session A context:
[compacted context from A]

Session B context:
[compacted context from B]

The code has been merged. [Conflict resolution notes, if any.]

The working directory reflects the merged state.
```

This gives Claude in the merged session:

- Full original context (from the forked JSONL)
- Detailed context from both branches (from the compacted summaries)
- Awareness of the merge and any conflict resolutions

### Branch structure

```
cc-session/{original-id}          ← export snapshot (common ancestor / merge base)
  ├── cc-session/{fork-a-id}      ← Alice's work (being merged in)
  └── cc-session/{fork-b-id}      ← Bob's work (merge target)
                                       │
                                       ▼
                              cc-session/{merged-id}  ← merged result (new branch)
```

The merge creates a new branch `cc-session/{merged-id}` with a git merge commit that has both fork branches as parents. This preserves full git history.

### What gets merged into what

The `--into` flag specifies the target. This can be:

- A fork URL (another session from the same DS server)
- A local branch name

The merge is always: fork → target, producing a new session. Neither the fork nor the target session is modified.

**Ancestry requirement:** the tool verifies that the fork and target share a common ancestor (the original export branch). If they don't, the merge is rejected with an error — there's no sensible base for a three-way merge.

### Invoking the agent

The merge tool invokes Claude for three tasks:

1. **Generating summaries** (for conflict resolution) — short summaries via `claude -r <session-id> --fork-session -p "summarize..."`. Original sessions are untouched thanks to `--fork-session`.
2. **Resolving merge conflicts** — the agent runs in the merged worktree via `claude -p "resolve conflicts..."` with summaries as context. It uses git tools to find and fix conflicts itself.
3. **Getting compacted contexts** (for the merged session) — detailed context via `claude -r <session-id> --fork-session -p "give me detailed context..."`. Richer than the summaries, used to brief Claude in the merged session.

All three use `claude -p` (CC print mode) with `--fork-session` where needed to avoid mutating existing sessions.

---

## Deliverables

| #   | Deliverable                            | Description                                                                |
| --- | -------------------------------------- | -------------------------------------------------------------------------- |
| 1   | **Session context extractor**          | Queries sessions via `--fork-session` for summaries and compacted contexts |
| 2   | **Git merge with conflict resolution** | Git merge + agent-assisted conflict resolution using summaries             |
| 3   | **Merged session creator**             | Forks original session via `--fork-session`, appends merge context         |
| 4   | **`ds-cc merge` command**              | CLI that orchestrates the full merge flow                                  |
| 5   | **Ancestry verification**              | Validates common ancestor exists before attempting merge                   |

### Ordering

1. **Session summarizer** (deliverable 1) — standalone, testable independently
2. **Git merge** (deliverable 2) — needs summarizer for conflict context
3. **Merged session creator** (deliverable 3) — needs summarizer output
4. **CLI command** (deliverable 4, 5) — orchestrates everything

---

## Resolved questions

1. **Merge target** — merge into any session that shares a common ancestor with the fork. The tool verifies ancestry.

2. **JSONL merge strategy** — don't merge JSONL entries. Start from the original session's JSONL (the shared base), append a synthetic summary message. Avoids compacting or diffing JSONL.

3. **Code + context merge** — not independent. The session summaries are generated first, then used for both code conflict resolution and the context message. This keeps them consistent.

4. **Session mutation** — neither the fork nor the target session is mutated. The merge produces a new session C with its own ID and branch.

5. **Agent invocation** — use `claude -p` (CC print mode) for both summarization and conflict resolution. No API key setup needed.

---

## Example end-to-end flow

Alice exports her session:

```
ds-cc fork --server https://ds.example.com
→ Fork URL: https://ds.example.com/cc/original-123
→ Branch: cc-session/original-123
```

Bob and Carol each clone it:

```
ds-cc clone https://ds.example.com/cc/original-123
→ Bob works on session bob-456, branch cc-session/bob-456
→ Carol works on session carol-789, branch cc-session/carol-789
```

Bob finishes and forks his work:

```
ds-cc fork --server https://ds.example.com
→ Fork URL: https://ds.example.com/cc/bob-456
→ Branch: cc-session/bob-456 (updated with his commits)
```

Carol finishes and wants to merge Bob's work into hers:

```
ds-cc merge https://ds.example.com/cc/bob-456 --into cc-session/carol-789
→ Summarizes both sessions
→ Merges code (resolves 1 conflict)
→ Creates session merged-abc on branch cc-session/merged-abc
→ Carol runs: cd ./session-merged-abc && claude --continue
```

Claude in the merged session knows:

- Everything from the original session (before the fork)
- What Bob did (summary)
- What Carol did (summary)
- That conflicts were resolved (and how)
- The code reflects the merged state

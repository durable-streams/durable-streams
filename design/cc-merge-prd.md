# PRD: CC session merge (Phase 3)

**Status:** Draft
**Date:** 2026-03-26
**Authors:** Kevin, Claude
**Depends on:** Phase 2 (CC session fork and clone)

---

## Problem

Phase 2 enables forking CC sessions and working independently. But forked sessions eventually need to be brought back together — the code changes need to be merged and Claude needs to understand what happened in both branches.

## Goal

Merge two local CC sessions that share a common ancestor, combining both the code (via git merge) and the conversation context (via summaries of both sessions' work). The result is a new CC session with the merged code and full awareness of what both sessions did.

## Non-goals (Phase 3)

- **Real-time collaborative editing** — this is offline merge, not live collaboration
- **Remote session merging** — both sessions must be local. Clone remote sessions first via `ds-cc clone`.
- **Automatic conflict resolution without agent** — an agent (Claude) resolves conflicts
- **JSONL-level merge** — we don't diff/merge individual JSONL entries; we summarize

## User experience

### Merging two local sessions

```
$ ds-cc merge <session-id-A> <session-id-B>
Found session A: cc-session/clone-abc123 (examples/cc-live-share/merge-test.ts modified)
Found session B: cc-session/clone-def456 (examples/cc-live-share/merge-test.ts modified)
Common ancestor: fa0a8704

Merging code...
  1 conflict in examples/cc-live-share/merge-test.ts
  Resolving conflicts with agent...
  Agent resolved 1 conflict
  Merge committed.

Generating contexts for merged session...

Creating merged session...
  Session ID: merged-789...

Ready! Start the merged session with:
  cd ./session-merge-789 && claude --continue
```

### Simple case (no conflicts)

```
$ ds-cc merge <session-id-A> <session-id-B>
Found session A: ...
Found session B: ...

Merging code...
  Clean merge, no conflicts.

Creating merged session...

Ready! Start the merged session with:
  cd ./session-merge-789 && claude --continue
```

### Merging a remote session

If one session is on another machine, clone it first:

```
$ ds-cc clone <fork-url>           # gives you a local session
$ ds-cc merge <local-A> <local-B>  # now merge locally
```

---

## Technical design

### Inputs

Both arguments are CC session IDs. The merge command finds each session's JSONL on disk at `~/.claude/projects/{encoded-cwd}/{session-id}.jsonl` and reads the `gitBranch` field from the JSONL entries.

### Discovering sessions

Given a session ID, the merge command:

1. Searches `~/.claude/projects/*/` for a JSONL file matching the session ID
2. Reads the JSONL to extract `gitBranch` and `cwd`
3. Uses the git branch for the code merge

### Merge flow

```
┌───────────────────────────┐
│  1. Find both sessions    │
│  (JSONL + git branches)   │
└─────────────┬─────────────┘
              │
┌─────────────▼─────────────┐
│  2. Verify common         │
│  ancestor (git merge-base)│
└─────────────┬─────────────┘
              │
┌─────────────▼─────────────┐
│  3. Git merge             │
│  (on new merge branch     │
│   in a worktree)          │
└─────────────┬─────────────┘
              │
   conflicts? ├──── no ──────────────┐
              │                      │
┌─────────────▼─────────────┐        │
│  4. Get brief summaries   │        │
│  from both session JSONLs │        │
│  + invoke agent to        │        │
│  resolve conflicts        │        │
└─────────────┬─────────────┘        │
              │                      │
┌─────────────▼──────────────────────▼┐
│  5. Get detailed contexts from      │
│  both sessions (for merged session) │
└─────────────┬───────────────────────┘
              │
┌─────────────▼─────────────┐
│  6. Create merged session │
│  (session A's JSONL +     │
│   synthetic merge message)│
└───────────────────────────┘
```

### Step 1: Find both sessions

For each session ID, search `~/.claude/projects/*/` for the matching JSONL file. Extract:

- `gitBranch` — the git branch the session was working on
- `cwd` — the working directory
- The JSONL content — for context extraction later

### Step 2: Verify common ancestor

```
git merge-base <branch-A> <branch-B>
```

If no common ancestor exists, reject the merge — the sessions didn't diverge from the same point.

### Step 3: Git merge

Create a merge worktree from session A's branch, then merge session B's branch into it:

```
git worktree add ./session-merge-{id} -b cc-session/merge-{id} <branch-A>
cd ./session-merge-{id}
git merge <branch-B> --no-commit --no-ff
```

### Step 4: Conflict resolution (only if conflicts)

Read both sessions' JSONL to extract conversation context, then use `claude -p` to generate brief summaries. Invoke an agent in the merge worktree to resolve conflicts:

```
claude -p "Two branches are being merged with conflicts.
Branch A did: [summary from A's JSONL]
Branch B did: [summary from B's JSONL]
Resolve all merge conflicts. Use git status to find them." --dangerously-skip-permissions
```

### Step 5: Get detailed contexts

Read both sessions' JSONL and use `claude -p` to generate detailed summaries of what each session accomplished. These are used in the merged session's context message.

### Step 6: Create merged session

1. Take session A's JSONL as the base (the shared starting context)
2. Append a synthetic merge context message with both detailed summaries
3. Rewrite path-sensitive fields for the merge worktree
4. Write to `~/.claude/projects/{encoded-merge-cwd}/{merged-session-id}.jsonl`

The synthetic message gives Claude awareness of both branches' work:

```
Two branches of work have been merged into this session.

Session A (branch cc-session/clone-abc):
[detailed context from A]

Session B (branch cc-session/clone-def):
[detailed context from B]

The code has been merged. [Conflict notes if any.]
The working directory reflects the merged state.
```

---

## Deliverables

| #   | Deliverable                         | Description                                              |
| --- | ----------------------------------- | -------------------------------------------------------- |
| 1   | **Session finder**                  | Locates JSONL and git branch for a session ID            |
| 2   | **Context extractor**               | Reads JSONL, generates summaries via `claude -p`         |
| 3   | **Git merge + conflict resolution** | Merge branches, agent resolves conflicts                 |
| 4   | **Merged session creator**          | Base JSONL + synthetic merge context                     |
| 5   | **`ds-cc merge` command**           | CLI that takes two session IDs and orchestrates the flow |

---

## Resolved questions

1. **Merge inputs** — two local session IDs. Both must exist on the local machine. Remote sessions must be cloned first.

2. **No DS required for merge** — merge operates entirely on local data (JSONL files + git branches). DS is only for fork/clone (moving sessions between machines).

3. **JSONL merge strategy** — take session A's JSONL as the base, append a synthetic summary. No JSONL diffing.

4. **Session mutation** — neither input session is modified. Merge produces a new session in a new worktree.

5. **Agent invocation** — `claude -p` for summaries, `claude -p --dangerously-skip-permissions` for conflict resolution.

---

## Example end-to-end flow

Alice has a session and forks it to DS:

```
ds-cc fork --server https://ds.example.com
→ Fork URL: https://ds.example.com/cc/original-123/1774535000000
```

Bob and Carol each clone it:

```
# Bob
ds-cc clone https://ds.example.com/cc/original-123/1774535000000
→ Local session: bob-456 in ./session-abc

# Carol
ds-cc clone https://ds.example.com/cc/original-123/1774535000000
→ Local session: carol-789 in ./session-def
```

Bob and Carol work independently in their sessions, making code changes via CC.

Carol wants to merge Bob's work. Bob forks his session to DS, Carol clones it:

```
# Bob forks his work
cd ./session-abc && ds-cc fork --server https://ds.example.com

# Carol clones Bob's fork
ds-cc clone https://ds.example.com/cc/bob-456/1774536000000
→ Local session: bob-local-111 in ./session-ghi
```

Carol merges:

```
ds-cc merge bob-local-111 carol-789
→ Merges code (resolves conflicts if any)
→ Creates merged session in ./session-merge-xyz
→ cd ./session-merge-xyz && claude --continue
```

Claude in the merged session knows what both Bob and Carol did.

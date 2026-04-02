# PRD: CC skills for fork and merge

**Status:** Draft
**Date:** 2026-03-30
**Authors:** Kevin, Claude

---

## Problem

Using the ds-cc CLI for forking and merging requires remembering session IDs, server URLs, git commands (commit, push), and multiple manual steps. Since the work is done inside CC sessions, we can use CC skills (slash commands) to automate this.

## Goal

Two CC skills — `/fork` and `/merge` — that automate the full workflow from within a CC session. One command to fork, one command to merge.

## Skills

### `/fork [server-url]`

Exports the current CC session to a Durable Stream and pushes the code state to git.

**Steps the skill tells CC to do:**

1. If no server URL argument, ask the user for the DS server URL
2. Commit all working changes: `git add -A && git commit -m "CC session fork"`
3. Push the current branch to origin
4. Run: `ds-cc fork --session ${CLAUDE_SESSION_ID} --server <url>`
5. Print the fork URL to the user

**Skill file** (`skills/fork/SKILL.md`):

```markdown
---
name: fork
description: Fork (export) this CC session to a Durable Stream
---

Fork the current CC session. This commits and pushes your current code
changes, then exports the session to a Durable Stream so others can
clone it.

1. The server URL is: $ARGUMENTS (if empty, ask the user for the DS server URL)
2. Commit all uncommitted changes: git add -A && git commit -m "CC session fork"
3. Push the current branch to origin: git push origin HEAD
4. Run: npx tsx <ds-cc-path>/src/cli.ts fork --session ${CLAUDE_SESSION_ID} --server <url>
5. Print the fork URL that was output by the command
```

### `/merge <session-id-or-fork-url>`

Merges another session into the current one.

**Steps the skill tells CC to do:**

1. Commit all working changes: `git add -A && git commit -m "CC session pre-merge"`
2. Push the current branch to origin
3. Detect if the argument is a URL (contains `://`) or a local session ID
4. If fork URL: clone it first with `ds-cc clone --fast <url>`, note the session ID from the output
5. Run: `ds-cc merge ${CLAUDE_SESSION_ID} <other-session-id>`
6. Print the merge worktree path and instructions to resume

**Skill file** (`skills/merge/SKILL.md`):

```markdown
---
name: merge
description: Merge another CC session into this one
---

Merge another CC session into the current session. The argument can be
either a local session ID or a fork URL (which will be cloned first).

1. The argument is: $ARGUMENTS (if empty, ask the user what to merge)
2. Commit all uncommitted changes: git add -A && git commit -m "CC session pre-merge"
3. Push the current branch to origin: git push origin HEAD
4. Determine the other session ID:
   - If the argument contains "://" it's a fork URL. Clone it first:
     Run: npx tsx <ds-cc-path>/src/cli.ts clone <url>
     The clone command prints "New session ID: <id>" — that is the other session ID.
   - Otherwise the argument itself is the other session ID.
5. Run: npx tsx <ds-cc-path>/src/cli.ts merge ${CLAUDE_SESSION_ID} <the-other-session-id-from-step-4>
6. Tell the user: "Merged session created. Exit this session and run:
   cd <merge-path> && claude --continue"
```

## Installation

The skills are bundled in `examples/cc-live-share/skills/`. To install in a project:

```bash
# Symlink the skills into your project
ln -s /path/to/examples/cc-live-share/skills/fork .claude/skills/fork
ln -s /path/to/examples/cc-live-share/skills/merge .claude/skills/merge
```

Or a setup command:

```bash
npx tsx /path/to/examples/cc-live-share/src/cli.ts install-skills
```

This creates the symlinks automatically.

## Configuration

The skills reference the ds-cc CLI path. This is configured via:

- The skill file directly references the path (for local development)
- In the future, ds-cc could be a globally installed bin

## Deliverables

| #   | Deliverable                  | Description                                                                      |
| --- | ---------------------------- | -------------------------------------------------------------------------------- |
| 1   | **`/fork` skill**            | SKILL.md that automates fork workflow                                            |
| 2   | **`/merge` skill**           | SKILL.md that automates merge workflow (supports both session IDs and fork URLs) |
| 3   | **`install-skills` command** | CLI command to symlink skills into a project                                     |

## Future

- `/clone` as a standalone CLI command (not a skill — it's run outside a CC session)
- `/share` and `/follow` as skills (Phase 1 live sharing from within CC)
- Global ds-cc installation via npm for easier skill paths

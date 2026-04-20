---
name: checkin
description: Check in this CC session for tracking via sesh
---

Mark the current Claude Code session for tracking in the sesh index. This means the session will be persisted to a Durable Stream on each git commit (if the pre-commit hook is installed).

Steps:

1. Run: `sesh checkin --session ${CLAUDE_SESSION_ID} --agent claude`

   The `--agent claude` flag is always correct here since this skill runs inside Claude Code. It's passed explicitly so the command works even when the user hasn't configured a local agent preference via `sesh init --agent ...`.

2. Tell the user:
   - The session has been checked in
   - It will be pushed to the Durable Stream on each commit (if `sesh install-hooks` has been run)
   - They can also manually push with `sesh push`
   - Teammates who pull the repo can resume it in either Claude or Codex via `sesh resume <id> --agent <agent>`

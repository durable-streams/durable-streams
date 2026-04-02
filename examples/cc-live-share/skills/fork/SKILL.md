---
name: fork
description: Fork (export) this CC session to a Durable Stream
---

Fork the current CC session. This commits and pushes your current code changes, then exports the session to a Durable Stream so others can clone it.

Steps:

1. The DS server URL is: $ARGUMENTS
   If empty, ask the user for the DS server URL before proceeding.

2. Commit all uncommitted changes:

   ```
   git add -A && git commit -m "CC session fork" || true
   ```

   (The `|| true` handles the case where there's nothing to commit.)

3. Push the current branch to origin:

   ```
   git push origin HEAD
   ```

4. Run the fork command:

   ```
   cods fork --session ${CLAUDE_SESSION_ID} --server <the-server-url-from-step-1>
   ```

5. Print the fork URL that was output by the command. Tell the user they can share this URL and others can clone it with `cods clone <fork-url>`.

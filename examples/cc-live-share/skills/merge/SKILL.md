---
name: merge
description: Merge another CC session into this one
---

Merge another CC session into the current session. The argument can be either a local session ID or a fork URL (which will be cloned first).

Steps:

1. The argument is: $ARGUMENTS
   If empty, ask the user what session to merge (a session ID or a fork URL).

2. Commit all uncommitted changes:

   ```
   git add -A && git commit -m "CC session pre-merge" || true
   ```

   (The `|| true` handles the case where there's nothing to commit.)

3. Push the current branch to origin:

   ```
   git push origin HEAD
   ```

4. Determine the other session ID:
   - If the argument contains "://" it is a fork URL. Clone it first:
     ```
     cods clone <the-fork-url>
     ```
     The clone command prints "New session ID: <id>" in its output. That ID is the other session ID to use in step 5.
   - If the argument does NOT contain "://", it is already a local session ID. Use it directly in step 5.

5. Run the merge command:

   ```
   cods merge ${CLAUDE_SESSION_ID} <the-other-session-id-from-step-4>
   ```

6. The merge command prints the path to the merged session worktree. Tell the user:
   "Merged session created. Exit this session and run:
   cd <merge-worktree-path> && claude --continue"

---
name: checkin
description: Check in this CC session for tracking via sesh
---

Mark the current CC session for tracking in the sesh index. This means the session will be persisted to a Durable Stream on each git commit (if the pre-commit hook is installed).

Steps:

1. Run: `sesh checkin --session ${CLAUDE_SESSION_ID}`

2. Tell the user:
   - The session has been checked in
   - It will be pushed to the Durable Stream on each commit (if `sesh install-hooks` has been run)
   - They can also manually push with `sesh push`

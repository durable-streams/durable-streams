---
name: live-share
description: Live-share this CC session so others can follow along in real-time
---

Start live-sharing the current CC session via a Durable Stream. Others can watch the conversation unfold in real-time.

Steps:

1. The DS server URL is: $ARGUMENTS
   If empty, ask the user for the DS server URL before proceeding.

2. Run the share command in the background:

   ```
   cods share --session ${CLAUDE_SESSION_ID} --server <the-server-url-from-step-1> &
   ```

   Note: this must run in the background (with `&`) so the CC session can continue.

3. The command prints a stream URL. Tell the user:
   - The stream URL
   - Others can follow this session by running:
     `cods follow <stream-url>`
   - The sharing will continue as long as this CC session is active
   - To stop sharing, kill the background process

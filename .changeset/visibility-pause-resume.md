---
"@durable-streams/client": patch
---

Add page visibility handling to pause/resume syncing when browser tab is hidden/visible

- Pauses stream fetching when page becomes hidden to save battery and bandwidth
- Resumes syncing when page becomes visible again
- Uses a 3-state machine (active, pause-requested, paused) to prevent race conditions
- Avoids long-poll hangs when resuming by skipping the live parameter on first request after resume
- Properly cleans up visibility event listener when stream is cancelled

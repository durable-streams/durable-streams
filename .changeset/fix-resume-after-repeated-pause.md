---
"@durable-streams/client": patch
---

Fix a live stream going silent for good when the page is hidden again while the resume request after a previous hide is still in flight. The `pull()` that owes the pending read now waits for the next resume and retries, instead of returning without serving it.

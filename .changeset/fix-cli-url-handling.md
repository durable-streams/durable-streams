---
"@durable-streams/cli": patch
---

Fix URL handling when --url contains /v1/stream path

Previously, the CLI always appended `/v1/stream/{streamId}` to the provided URL. When users provided a URL that already contained `/v1/stream` (e.g., `http://localhost:3002/v1/stream/my-group`), it would incorrectly produce a doubled path like `/v1/stream/my-group/v1/stream/my-stream`.

Now the CLI correctly detects when the URL already contains `/v1/stream` and only appends the stream ID.

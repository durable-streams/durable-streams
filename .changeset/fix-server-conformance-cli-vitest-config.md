---
"@durable-streams/server-conformance-tests": patch
---

Fix CLI test discovery when run via `npx` from a consumer project. Vitest no longer inherits the host project's include/exclude patterns (which previously caused "No test files found" for `test-runner.js` under `node_modules`).

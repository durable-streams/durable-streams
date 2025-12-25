---
"@durable-streams/server-conformance-tests": patch
"@durable-streams/client-conformance-tests": patch
"@durable-streams/cli": patch
---

Fix npx executable discovery for all CLI packages. When running `npx @durable-streams/<package>`, npm now correctly finds the executable. Also fixes vitest binary path resolution in server-conformance-tests for scoped packages installed via npx.

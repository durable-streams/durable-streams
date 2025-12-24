---
"@durable-streams/client": patch
"@durable-streams/server": patch
"@durable-streams/state": patch
"@durable-streams/cli": patch
"@durable-streams/benchmarks": patch
"@durable-streams/client-conformance-tests": patch
"@durable-streams/server-conformance-tests": patch
---

Standardize package.json exports across all packages

- Add dual ESM/CJS exports to all packages
- Fix export order to have "." first, then "./package.json"
- Add proper main/module/types fields
- Add sideEffects: false
- Remove duplicate fields

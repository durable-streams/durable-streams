# Notes

Spec ambiguities, skipped tests, and platform-limit findings.

## Licensing

The mission brief described the reference server as MIT; `packages/server/package.json` says **Apache-2.0** (repo root LICENSE also Apache-2.0). Ported logic is attributed accordingly.

## Out of scope for v1 (per mission)

- Fork semantics (`Stream-Forked-From`)
- Experimental `__ds` subscription APIs
- Multi-region concerns

## Conformance suite facts (v0.3.5) that shape the plan

- 332 tests total; all logic in one vitest file. CLI: `--run <url>` / `--watch`; **no test filter, no timeout flag**. Only built-in gate: `subscriptions` (default **off**, so the 6 `__ds` subscription tests are skipped automatically — no action needed).
- **Fork tests (~82) run unconditionally** — the CLI offers no way to skip them. Consequence: with fork unimplemented, the official CLI run cannot be fully green. Plan: build phases 1–6 first (non-fork ≈ 250 tests), then implement fork semantics as the path to a green CLI run, since documented-but-failing tests are worse than implementing the feature. If fork proves infeasible on the platform, this note becomes the justification and a programmatic vitest run with `--testNamePattern` excluding `/^Fork/` documents the non-fork pass.
- Suite hardcodes paths under `/v1/stream/<name>` with `Date.now()` suffixes; no cleanup hooks — relies on unique paths.
- Long-poll: suite's wait budget is 20s (+1s vitest wrapper); server's own long-poll hold must finish (204) comfortably inside that.
- TTL: `Stream-TTL: 1` must genuinely expire within a few seconds (DO alarms give this). Sliding window: extend on read+write, never on HEAD.
- Beyond PROTOCOL.md, the suite asserts browser security headers: `X-Content-Type-Options: nosniff` (all responses incl. errors), `Cross-Origin-Resource-Policy`, `Cache-Control: no-store` on HEAD; and SSE CRLF-injection safety.
- Large payloads: max 10MB, and that test accepts 413 — Workers body limits are a non-issue.
- **Published CLI bug (0.3.5 + vitest 4)**: `--run` shells out to `vitest run <dist/test-runner.js>`, which vitest 4 rejects ("No test files found") because the file misses the default include glob. Dev loop uses the programmatic `runConformanceTests({ baseUrl })` in a local vitest file (same tests, same counts) — this mirrors the repo's own `packages/server/test/conformance.test.ts` harness. The npx CLI will be re-tested at final verification and its behavior documented.
- **Long-poll hold duration**: suite timeout tests expect the 204 idle response within vitest's 5s per-test budget; the reference conformance harness runs the server with `longPollTimeout: 500`. This server defaults its long-poll hold to 2s: > the ~500ms the delivery tests need, < the 5s budget.
- SSE: must stream chunked (no Content-Length), and the final append must be delivered to live SSE readers before the close control event (race is probed deterministically).

## Skipped tests

(None yet — populated as the suite is run.)

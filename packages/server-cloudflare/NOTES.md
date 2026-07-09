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

**None skipped by us.** The suite reports `326 passed | 6 skipped (332)`; the 6 skips are the suite's own `subscriptions`-gated webhook tests (`describe.runIf(options.subscriptions)`, off by default in the CLI and programmatic default). Everything else — including all 82 fork tests, originally out-of-scope but pulled in because the CLI cannot skip them — passes.

## Running the suite against the deployed instance: client RTT matters

The suite assumes a nearby server: most tests run under vitest's default **5s** budget, and several (property-based fuzz groups, multi-step fork/TTL tests, the SSE close-race prober) issue **dozens to hundreds of sequential HTTP round-trips**. Against `wrangler dev` (RTT ≈ 0) everything passes; against the deployed workers.dev instance from a distant client (~300ms RTT from this dev machine in Australia), 12–14 of those tests exceed 5s purely on network arithmetic (e.g. 40 round-trips × 300ms = 12s > 5s). Additionally, the suite's SSE reader parses possibly-truncated buffers; over the public internet TCP segmentation can split an SSE frame mid-event at the moment its stop-marker matches, which no server can prevent (verified manually: live SSE delivers correctly framed events immediately, with `content-encoding: identity` to defeat edge compression buffering).

**Resolution:** the authoritative live-instance run happens in CI (`.github/workflows/live-conformance.yml`) from a GitHub runner with ~1ms RTT to Cloudflare's edge; its summary is uploaded as the `live-conformance-summary` artifact.

## Adversarial review outcomes (multi-agent, 4 lenses + verification)

20 confirmed findings, all fixed (commit "Apply adversarial-review fixes"); highlights:
- **Fork-create race**: cross-DO RPC awaits open the DO input gate; concurrent PUTs could double-create (PK violation → 500) and permanently leak a source refcount. Fixed with post-await existence re-checks + release-on-failure.
- **GC durability**: a failed `forkRelease` RPC after a purge would leak the parent's refcount forever. Fixed with a durable `gc_queue` retried from the alarm handler. (Known trade-off: if a release RPC succeeds but its ack is lost, the retry can double-decrement; `decrementRef` floors at 0 and the window is a single RPC ack — accepted for v1.)
- **Unbounded reads**: catch-up GET / fork `readRange` buffered whole streams (DO memory, ~32MiB RPC clone cap). Fixed with 4MB byte-capped batches; partial responses omit `Stream-Up-To-Date` per §5.6.
- **SSE generation safety**: an SSE tail could survive DELETE+recreate and deliver the new stream's data on the old subscription. Fixed with per-creation generation ids.

## Remaining v1 limitations (documented, not bugs)

- No retention/trimming: streams grow until deleted or expired; a single stream tops out at the DO's 10GB SQLite cap.
- Append body cap ~1.9MB (DO SQLite 2MB value limit); the protocol's 413 is returned above it (the suite's 10MB test accepts 413).
- Worker-level Cache API caching of catch-up reads was deliberately not added: origin responses already carry the spec's recommended `Cache-Control`/`ETag` headers, so Cloudflare's edge caches catch-up chunks without extra code; an explicit Cache API layer adds read-your-writes risk for no conformance gain.
- `Stream-Seq` scope (spec §12.6 requires documenting): enforced **per stream**, not per writer identity.
- Expired streams return 404 and the path is recreatable (spec leaves this underspecified; matches the reference server).

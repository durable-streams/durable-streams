# Progress

## Current phase

**COMPLETE.** All deliverables done: local + live conformance fully green (326/0/6 both), CI green (honestly — pipefail), deployed, smoke test green, ai-chat example done.

## Suite status (local, wrangler dev, suite 0.3.5)

**326 passed | 0 failed | 6 skipped (332)** — matches the reference server baseline exactly.
Stability: 5 consecutive full-green runs after fixing the oversized-upload EPIPE flake.

Client smoke test (`scripts/smoke-test.mjs`): PASSED — 1,000 events via IdempotentProducer batches, mid-offset catch-up, SSE live tail while appending, EOF in catch-up/long-poll/SSE.

Milestones:

| Milestone | Result | Commit |
|---|---|---|
| Scaffold (worker + DO + SQLite schema) | boots, routes | 27c2418 |
| Phases 1–6 port (lifecycle, reads, long-poll, SSE, producers, closure, TTL, HTTP) | 247 pass / 79 fail (all fork) | 3c43dc6 |
| Phase 7 fork semantics (cross-DO RPC) | 326 pass / 0 fail | 867ab76 |
| 413 drain flake fix | 5× consecutive green | (next) |

## Step 0 answer: does the reference server separate protocol handling from storage?

**No — not in an importable way.** The published `@durable-streams/server` (0.3.7) has no storage-agnostic protocol core: the HTTP/protocol layer (`server.ts`) is built directly on `node:http`, and the "storage" layer (`store.ts`/`file-store.ts`) itself contains protocol logic (producer validation, offset math, JSON framing, long-poll waiter registration). It also depends on `lmdb` (native). Therefore: **port module-by-module**, lifting verbatim only the pure pieces — `cursor.ts`, the JSON-mode helpers, the producer validation state machine (extracted to a pure function), and the protocol header constants — and rewriting the HTTP layer against Workers `Request`/`Response` with a DO-SQLite store. Ports are attributed (Apache-2.0).

Key ported invariants: offset format `<16-digit readSeq>_<16-digit byteOffset>` (byteOffset advances by 5 + payload length per message), lexicographic offset comparison, producer validation before Stream-Seq check, closed → content-type → seq error precedence, data-waiters-before-close-waiters notification order.

Baseline (reference server 0.3.7, suite 0.3.5): 326 passed, 6 skipped, 0 failed.

## Review + deploy status

- Adversarial multi-agent review (4 lenses, 32 agents): 20 confirmed findings, all fixed (see NOTES.md).
- Deployed: https://durable-object-streams.openstory.workers.dev (fork race fix verified live; SSE verified streaming unbuffered).
- CI surfaced a real workerd bug (early error responses mid-upload reset the DO → 503s); fixed by consuming bodies before validation.
- GitHub: https://github.com/tombeckenham/durable-object-streams — `conformance` (wrangler dev) + `live-conformance` (deployed URL) workflows.
- Stretch `examples/ai-chat`: done; HTTP flow verified headlessly (producer-dedup resume + SSE offset resume + EOF).

## Remaining work

- [ ] Both CI workflows green; capture live-URL conformance summary artifact into README.

## Blockers

None.

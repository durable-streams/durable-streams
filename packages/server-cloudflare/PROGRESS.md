# Progress

## Current phase

Phase 1 — Lifecycle & catch-up reads (Step 0 recon complete)

## Step 0 answer: does the reference server separate protocol handling from storage?

**No — not in an importable way.** The published `@durable-streams/server` (0.3.7) has no storage-agnostic protocol core: the HTTP/protocol layer (`server.ts`) is built directly on `node:http`, and the "storage" layer (`store.ts`/`file-store.ts`) itself contains protocol logic (producer validation, offset math, JSON framing, long-poll waiter registration). It also depends on `lmdb` (native). Therefore: **port module-by-module**, lifting verbatim only the pure pieces — `cursor.ts`, the JSON-mode helpers (`normalizeContentType`, `processJsonAppend`, `formatJsonMessages`), the producer validation state machine (extracted to a pure function), and the protocol header constants — and rewriting the HTTP layer against Workers `Request`/`Response` with a DO-SQLite store implementing the same ~16-method store contract. Ports are attributed (Apache-2.0).

Key ported invariants: offset format `<16-digit readSeq>_<16-digit byteOffset>` (readSeq always 0; byteOffset advances by 5 + payload length per message — 4-byte length prefix + newline frame overhead), lexicographic offset comparison, producer validation before Stream-Seq check, closed-check before content-type-check before seq-check error precedence, data-waiters-before-close-waiters notification order.

## Suite status

Not yet run against this implementation.

Baseline (reference server `@durable-streams/server` 0.3.7, suite pinned **0.3.5**): **326 passed, 6 skipped, 0 failed** (332 total, ~15s). The 6 skips are the suite's own `subscriptions`-gated webhook tests, off by default. A green run therefore includes the ~82 fork tests — fork is required, not optional (see NOTES.md).

## Recon findings so far

- Reference server (`@durable-streams/server` 0.3.7, **Apache-2.0**, not MIT as the mission brief said — attribution comments will cite Apache-2.0):
  - Published package depends on `lmdb` (native Node) and `node:http` — **not importable into Workers**.
  - Structure: `server.ts` (protocol/HTTP logic) + `store.ts` (in-memory store) + `file-store.ts` (LMDB store) — protocol logic appears separated from storage behind a store shape; porting `server.ts` + `store.ts` semantics onto DO SQLite is the plan. Final answer pending full analysis.
  - Offset format: `<read-seq>_<byte-offset>`, both 16-digit zero-padded (e.g. `0000000000000012_0000000000004096`). Uses `_` only — safe re: forbidden chars (`,` `&` `=` `?` `/`).
  - Cursor: time-interval counter (20s intervals since 2024-10-09 epoch) with monotonicity + jitter on collision, for CDN cache collapsing.
  - TTL: `lastAccessedAt` updated on GET and POST, NOT on HEAD.

## Blockers

None.

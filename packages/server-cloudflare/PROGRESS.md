# Progress

## Current phase

Step 0 — Recon (in progress)

## Suite status

Not yet run against this implementation.

## Recon findings so far

- Reference server (`@durable-streams/server` 0.3.7, **Apache-2.0**, not MIT as the mission brief said — attribution comments will cite Apache-2.0):
  - Published package depends on `lmdb` (native Node) and `node:http` — **not importable into Workers**.
  - Structure: `server.ts` (protocol/HTTP logic) + `store.ts` (in-memory store) + `file-store.ts` (LMDB store) — protocol logic appears separated from storage behind a store shape; porting `server.ts` + `store.ts` semantics onto DO SQLite is the plan. Final answer pending full analysis.
  - Offset format: `<read-seq>_<byte-offset>`, both 16-digit zero-padded (e.g. `0000000000000012_0000000000004096`). Uses `_` only — safe re: forbidden chars (`,` `&` `=` `?` `/`).
  - Cursor: time-interval counter (20s intervals since 2024-10-09 epoch) with monotonicity + jitter on collision, for CDN cache collapsing.
  - TTL: `lastAccessedAt` updated on GET and POST, NOT on HEAD.

## Blockers

None.

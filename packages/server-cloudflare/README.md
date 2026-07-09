# durable-object-streams

A conformant [Durable Streams](https://github.com/durable-streams/durable-streams) protocol server on **Cloudflare Workers + Durable Objects**, in TypeScript.

Every stream is its own Durable Object instance (`idFromName(streamPath)`), giving the protocol's per-stream serialization and durability-before-ack for free via the DO input/output gates. All state lives in DO SQLite; long-poll waiters and SSE tails are held in the object; sliding TTLs use DO alarms; fork semantics (refcounted soft-delete, stitched reads, cascade GC) work across objects via DO-to-DO RPC.

## Conformance

Validated with `@durable-streams/server-conformance-tests` **0.3.5** — the full suite, including fork semantics and idempotent-producer fencing:

```
Test Files  1 passed (1)
     Tests  326 passed | 6 skipped (332)
```

- **326 passed, 0 failed** — identical to the upstream reference server's result.
- The 6 skips are the suite's own `subscriptions`-gated webhook tests (off by default; the experimental `__ds` subscription control plane is out of scope here — see NOTES.md).

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | Worker: routes each path to its stream DO, CORS preflight, bearer-token auth hook |
| `src/stream-object.ts` | `StreamObject` DO: all protocol semantics (PUT/GET/POST/DELETE/HEAD, long-poll, SSE, producers, closure, TTL, forks) |
| `src/store.ts` | SQLite access layer (`meta` / `messages` / `producers` tables) |
| `src/producer.ts` | Pure idempotent-producer validation state machine |
| `src/json.ts` | JSON-mode helpers (array flattening, fragment storage, array-wrapped reads) |
| `src/cursor.ts` | CDN cache-collapsing cursor math |
| `conformance/` | Dev-loop harness invoking the conformance suite programmatically |
| `scripts/smoke-test.mjs` | End-to-end smoke test using `@durable-streams/client` |

Protocol/validation logic is ported from the Apache-2.0 [reference server](https://github.com/durable-streams/durable-streams/tree/main/packages/server) (attributed in file headers), rewritten for Workers `Request`/`Response` and DO SQLite.

## Develop

```bash
npm install
npm run dev                # wrangler dev on port 8787 (local DO SQLite, no credentials needed)
npm run conformance        # full conformance suite against localhost:8787
node scripts/smoke-test.mjs # client smoke test
```

The conformance script runs the suite via its programmatic entrypoint because the published CLI (0.3.5) is broken under vitest 4 (see NOTES.md). Same tests, same counts.

## Deploy

```bash
npx wrangler login   # or export CLOUDFLARE_API_TOKEN
npm run deploy
```

Then point the suite at your workers.dev URL:

```bash
CONFORMANCE_TEST_URL=https://durable-object-streams.<your-subdomain>.workers.dev npm run conformance
```

To require auth, set a secret and send `Authorization: Bearer <token>`:

```bash
npx wrangler secret put AUTH_TOKEN
```

## Design notes

- **Offsets** use the reference format `<readSeq>_<byteOffset>` (16-digit zero-padded, lexicographically sortable); each message advances the byte offset by `payload + 5` (frame overhead), matching the reference server byte-for-byte.
- **Concurrency**: request bodies are read before any state is examined; every validate-then-write block is synchronous over the SQLite API, so the DO event loop makes it atomic — no locks needed.
- **TTL** is enforced lazily on access (exact) *and* by a DO alarm (storage reclamation), so 1-second TTLs expire promptly.
- **Body cap** is ~1.9MB per append (DO SQLite's 2MB value limit); larger appends get the protocol's `413`.
- **Forks**: creating a fork atomically validates + refcounts the source inside the source's DO (`forkAcquire`); deleting a referenced stream soft-deletes it (`410 Gone`), and the last fork release cascades a hard purge up the chain.

## CI

`.github/workflows/conformance.yml` boots `wrangler dev`, runs the full conformance suite and the client smoke test on every push/PR; a failing suite fails the build.

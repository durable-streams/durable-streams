# durable-object-streams

A conformant [Durable Streams](https://github.com/durable-streams/durable-streams) protocol server on **Cloudflare Workers + Durable Objects**, in TypeScript — consumable as a library you mount in your own Worker.

Every stream is its own Durable Object instance (`idFromName(streamPath)`), giving the protocol's per-stream serialization and durability-before-ack for free via the DO input/output gates. All state lives in DO SQLite; long-poll waiters and SSE tails are held in the object; sliding TTLs use DO alarms; fork semantics (refcounted soft-delete, stitched reads, cascade GC) work across objects via DO-to-DO RPC.

## Use as a library

```bash
pnpm add durable-object-streams   # or npm install / yarn add
```

Your Worker entry:

```ts
// src/index.ts
import { createStreamsHandler } from "durable-object-streams";

export { StreamObject } from "durable-object-streams";

export default {
  fetch: createStreamsHandler(),
};
```

Your wrangler config — the DO binding **must be named `STREAMS`** (fork semantics do DO-to-DO RPC through it) and needs a SQLite migration:

```jsonc
// wrangler.jsonc
{
  "name": "my-streams",
  "main": "src/index.ts",
  "compatibility_date": "2025-06-01",
  "durable_objects": {
    "bindings": [{ "name": "STREAMS", "class_name": "StreamObject" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["StreamObject"] }],
}
```

Streams live at `/<path>` — the full request pathname is the stream path. If you mount the handler inside a larger Worker, route only the stream URLs to it (fork references between streams use these paths, so keep them stable).

### Auth

The protocol leaves auth to the implementation. By default, if an `AUTH_TOKEN` var/secret is set and non-empty, every request must carry `Authorization: Bearer <token>` (`npx wrangler secret put AUTH_TOKEN`); otherwise the server is open. Pass your own hook to replace that — return a `Response` to reject (CORS headers are added for you), `undefined` to allow:

```ts
export default {
  fetch: createStreamsHandler({
    auth: async (request, env) => {
      if (!(await isAuthorized(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }
      return undefined;
    },
  }),
};
```

`createStreamsHandler({ cors: false })` omits the permissive default CORS headers.

## Conformance

Validated with `@durable-streams/server-conformance-tests` **0.3.5** (pinned in `devDependencies`; the version this implementation is certified against) — the full suite, including fork semantics and idempotent-producer fencing.

Against local `wrangler dev` (CI: [`conformance`](.github/workflows/conformance.yml), every push):

```
 Test Files  1 passed (1)
      Tests  326 passed | 6 skipped (332)
```

Against the deployed instance `https://durable-object-streams.openstory.workers.dev` (CI: [`live-conformance`](.github/workflows/live-conformance.yml), summary uploaded as an artifact):

```
 Test Files  1 passed (1)
      Tests  326 passed | 6 skipped (332)
   Duration  649.57s
```

- **326 passed, 0 failed** in both environments — identical to the upstream reference server's result.
- The 6 skips are the suite's own `subscriptions`-gated webhook tests (off by default; the experimental `__ds` subscription control plane is out of scope — see NOTES.md).
- The live run uses `--testTimeout=120000 --retry=2` purely for network-transport reasons (RTT arithmetic on 1,000+-round-trip tests; Cloudflare edge SSE re-chunking racing the suite's reader) — no test logic changes; NOTES.md has the full evidence.
- The published `--run` CLI is broken upstream with vitest 4 ("No test files found" from any directory); all runs use the suite's programmatic `runConformanceTests` entrypoint — the same 332 tests, same mechanism as the upstream repo's own harness.

## Layout

| Path                     | What it is                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`           | Library entry: exports `StreamObject`, `createStreamsHandler`, types                                                 |
| `src/handler.ts`         | Worker router factory: per-path DO routing, CORS preflight, auth hook                                                |
| `src/stream-object.ts`   | `StreamObject` DO: all protocol semantics (PUT/GET/POST/DELETE/HEAD, long-poll, SSE, producers, closure, TTL, forks) |
| `src/store.ts`           | SQLite access layer (`meta` / `messages` / `producers` tables)                                                       |
| `src/producer.ts`        | Pure idempotent-producer validation state machine                                                                    |
| `src/json.ts`            | JSON-mode helpers (array flattening, fragment storage, array-wrapped reads)                                          |
| `src/cursor.ts`          | CDN cache-collapsing cursor math                                                                                     |
| `template/index.ts`      | The deployable Worker (wrangler `main`) — exactly what a consumer's entry looks like                                 |
| `conformance/`           | Dev-loop harness invoking the conformance suite programmatically                                                     |
| `scripts/smoke-test.mjs` | End-to-end smoke test using `@durable-streams/client`                                                                |

## Develop

Uses [pnpm](https://pnpm.io) (version pinned via `packageManager`; `corepack enable` gets you the right one).

```bash
pnpm install
pnpm dev                    # wrangler dev on port 8787 (local DO SQLite, no credentials needed)
pnpm conformance            # full conformance suite against localhost:8787
node scripts/smoke-test.mjs # client smoke test
pnpm build                  # emit dist/ (library build)
pnpm lint && pnpm format:check && pnpm typecheck
```

The conformance script runs the suite via its programmatic entrypoint because the published CLI (0.3.5) is broken under vitest 4 (see NOTES.md). Same tests, same counts.

## Deploy this repo directly

The repo itself is a deployable server (`template/index.ts` is the wrangler entry):

```bash
pnpm exec wrangler login   # or export CLOUDFLARE_API_TOKEN
pnpm deploy:worker
```

Then point the suite at your workers.dev URL:

```bash
CONFORMANCE_TEST_URL=https://durable-object-streams.<your-subdomain>.workers.dev pnpm conformance
```

## Design notes

- **Offsets** use the reference format `<readSeq>_<byteOffset>` (16-digit zero-padded, lexicographically sortable); each message advances the byte offset by `payload + 5` (frame overhead), matching the reference server byte-for-byte.
- **Concurrency**: request bodies are read before any state is examined; every validate-then-write block is synchronous over the SQLite API, so the DO event loop makes it atomic — no locks needed.
- **TTL** is enforced lazily on access (exact) _and_ by a DO alarm (storage reclamation), so 1-second TTLs expire promptly.
- **Body cap** is ~1.9MB per append (DO SQLite's 2MB value limit); larger appends get the protocol's `413`.
- **Forks**: creating a fork atomically validates + refcounts the source inside the source's DO (`forkAcquire`); deleting a referenced stream soft-deletes it (`410 Gone`), and the last fork release cascades a hard purge up the chain.

## CI

`.github/workflows/conformance.yml` typechecks, builds the library, boots `wrangler dev`, and runs the full conformance suite plus the client smoke test on every push/PR; a failing suite fails the build.

## License

[Apache-2.0](LICENSE). Protocol/validation logic is ported from the Apache-2.0 [reference server](https://github.com/durable-streams/durable-streams/tree/main/packages/server) (Durable Streams contributors) — see [NOTICE](NOTICE) and the per-file attribution headers.

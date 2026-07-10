# @durable-streams/server-cloudflare

A conformant [Durable Streams](https://github.com/durable-streams/durable-streams) protocol server on **Cloudflare Workers + Durable Objects**, in TypeScript — a library you mount in your own Worker.

Every stream is its own Durable Object instance (`idFromName(streamPath)`), giving the protocol's per-stream serialization and durability-before-ack for free via the DO input/output gates. All state lives in DO SQLite; long-poll waiters and SSE tails are held in the object; sliding TTLs use DO alarms; fork semantics (refcounted soft-delete, stitched reads, cascade GC) work across objects via DO-to-DO RPC.

## Usage

```bash
pnpm add @durable-streams/server-cloudflare   # or npm install / yarn add
```

Your Worker entry:

```ts
// src/index.ts
import { createStreamsHandler } from "@durable-streams/server-cloudflare"

export { StreamObject } from "@durable-streams/server-cloudflare"

export default {
  fetch: createStreamsHandler(),
}
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

The library's types reference Workers runtime types (`DurableObjectNamespace`, etc.) — generate them in your project with [`wrangler types`](https://developers.cloudflare.com/workers/languages/typescript/#generate-types).

Streams live at `/<path>` — the full request pathname is the stream path. If you mount the handler inside a larger Worker, route only the stream URLs to it (fork references between streams use these paths, so keep them stable). See the [`chat-cloudflare` example](../../examples/chat-cloudflare) for a TanStack Start app and this server sharing one Worker.

### Auth

The protocol leaves auth to the implementation. By default, if an `AUTH_TOKEN` var/secret is set and non-empty, every request must carry `Authorization: Bearer <token>` (`npx wrangler secret put AUTH_TOKEN`); otherwise the server is open. Pass your own hook to replace that — return a `Response` to reject (CORS headers are added for you), `undefined` to allow:

```ts
export default {
  fetch: createStreamsHandler({
    auth: async (request, env) => {
      if (!(await isAuthorized(request, env))) {
        return new Response("Unauthorized", { status: 401 })
      }
      return undefined
    },
  }),
}
```

`createStreamsHandler({ cors: false })` omits the permissive default CORS headers.

## Conformance

Validated with `@durable-streams/server-conformance-tests` — the full suite, including fork semantics and idempotent-producer fencing: **326 passed, 0 failed** (identical to the reference server; the 6 skips are the suite's own `subscriptions`-gated webhook tests, off by default — the experimental `__ds` subscription control plane is not implemented and returns `404`).

```bash
pnpm conformance   # boots template/index.ts via wrangler dev (test/wrangler.jsonc) and runs the suite
```

## Layout

| Path                   | What it is                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`         | Library entry: exports `StreamObject`, `createStreamsHandler`, types                                                 |
| `src/handler.ts`       | Worker router factory: per-path DO routing, CORS preflight, auth hook                                                |
| `src/stream-object.ts` | `StreamObject` DO: all protocol semantics (PUT/GET/POST/DELETE/HEAD, long-poll, SSE, producers, closure, TTL, forks) |
| `src/store.ts`         | SQLite access layer (`meta` / `messages` / `producers` tables)                                                       |
| `src/producer.ts`      | Pure idempotent-producer validation state machine                                                                    |
| `src/json.ts`          | JSON-mode helpers (array flattening, fragment storage, array-wrapped reads)                                          |
| `src/cursor.ts`        | CDN cache-collapsing cursor math                                                                                     |
| `template/index.ts`    | Worker entry the conformance test boots (the usage snippet above, complete)                                          |
| `test/`                | Conformance harness: boots `wrangler dev` and runs the shared suite                                                  |

## Develop

```bash
pnpm build       # emit dist/ (library build)
pnpm conformance # full conformance suite against a local wrangler dev instance
pnpm typecheck
```

Linting and formatting come from the repo root (`pnpm lint`, `pnpm format` at the monorepo root).

## Design notes

- **Offsets** use the reference format `<readSeq>_<byteOffset>` (16-digit zero-padded, lexicographically sortable); each message advances the byte offset by `payload + 5` (frame overhead), matching the reference server byte-for-byte.
- **Concurrency**: request bodies are read before any state is examined; every validate-then-write block is synchronous over the SQLite API, so the DO event loop makes it atomic — no locks needed.
- **TTL** is enforced lazily on access (exact) _and_ by a DO alarm (storage reclamation), so 1-second TTLs expire promptly.
- **Body cap** is ~1.9MB per append (DO SQLite's 2MB value limit); larger appends get the protocol's `413`.
- **Forks**: creating a fork atomically validates + refcounts the source inside the source's DO (`forkAcquire`); deleting a referenced stream soft-deletes it (`410 Gone`), and the last fork release cascades a hard purge up the chain.

## License

[Apache-2.0](LICENSE). Protocol/validation logic is ported from the Apache-2.0 [reference server](https://github.com/durable-streams/durable-streams/tree/main/packages/server) (Durable Streams contributors) — see [NOTICE](NOTICE) and the per-file attribution headers.

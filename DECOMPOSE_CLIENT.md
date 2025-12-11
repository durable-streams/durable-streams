# Durable Streams Read/Write API Split

**Design Doc**

## 1. Goals

### 1.1 High-level

We want to refactor the Durable Streams client into two clear layers:

1. **Read API (fetch-like)**
   - `stream(options)` → `Promise<StreamResponse>`
   - For apps that only need to **read** from streams.
   - Feels like `fetch`:
     - The promise only resolves after the **first network request** succeeds.
     - It rejects for auth/404/other protocol errors.

2. **Handle API (read/write)**
   - `StreamHandle` class for:
     - creating/deleting streams,
     - appending data,
     - spawning read sessions via `.stream(options)`.

We **do not** need backwards compatibility with the existing `DurableStream` API.

### 1.2 Behavioural goals

- **Fetch-like contract** for `stream()`:
  - `await stream(options)` only resolves once we have a first successful HTTP response / SSE connection.
  - If auth fails, stream is missing, or protocol is violated, the promise rejects.

- **Semi-lazy consumption**:
  - The initial request is made inside `stream()`.
  - The **first `Response` object** is held inside `StreamResponse` without reading or parsing its body.
  - We only validate that headers are good (correct status, no error) before resolving.
  - Body consumption (reading bytes, parsing JSON) happens only when the user calls a consumption method.
  - Additional reading (more responses, long-polls, SSE events) is triggered by consumption, not buffered in background.

- **Separation of config vs consumption**:
  - `offset` and `live` are **only** specified on the initial call to `stream()` / `StreamHandle.stream()`.
  - `StreamResponse` only exposes:
    - current state (`offset`, `cursor`, `upToDate`),
    - consumption methods (promises, streams, iterators, subscribers).

- **Protocol alignment**:
  - Use protocol concepts directly:
    - `offset` → query param,
    - `live` → read mode (`false`, `long-poll`, `sse`, `auto`),
    - `Stream-Next-Offset`, `Stream-Up-To-Date`, `Stream-Cursor` → exposed as `offset`, `upToDate`, `cursor` on `StreamResponse`.

---

## 2. Current API (for reference)

Today we have a single `DurableStream` class (simplified):

```ts
class DurableStream {
  readonly url: string
  readonly contentType?: string

  // static create/connect/head/delete

  append(
    body: BodyInit | Uint8Array | string,
    opts?: AppendOptions
  ): Promise<void>
  appendStream(
    source: AsyncIterable<Uint8Array | string>,
    opts?: AppendOptions
  ): Promise<void>

  read(opts?: ReadOptions): AsyncIterable<StreamChunk>
  toReadableStream(opts?: ReadOptions): ReadableStream<StreamChunk>
  toByteStream(opts?: ReadOptions): ReadableStream<Uint8Array>
  json(opts?: ReadOptions): AsyncIterable<unknown>
  text(opts?: ReadOptions): AsyncIterable<string>
}
```

Problems:

- Read + write are coupled; even read-only consumers get write methods.
- Read options (`offset`, `live`) sit on each read method, not on a “session”.
- No object that _just_ represents a streaming read session, fetch-style.

We’ll replace this with:

- a **standalone `stream()` function** for reads,
- a **`StreamHandle`** class for write/lifecycle + `.stream()`.

---

## 3. Target architecture

### 3.1 Read-only API

Exposes:

- `stream(options: StreamOptions): Promise<StreamResponse<TJson>>`
- All read-related types.

This is the **primary API for consumers** who only need to read from streams.

### 3.2 Handle API (read/write)

Exposes:

- `StreamHandle` class:
  - `create`, `head`, `delete`
  - `append`, `appendStream`
  - `stream(options)` → `StreamResponse<TJson>`

Used by backends or any code that needs to **write** to streams as well as read.

Both APIs are exported from `@durable-streams/client`.

---

## 4. Read API Design

### 4.1 `StreamOptions` (request-side configuration)

```ts
export type LiveMode = false | "auto" | "long-poll" | "sse"

export interface StreamOptions {
  url: string | URL

  // Auth / transport
  auth?: AuthOptions
  headers?: HeadersInit
  signal?: AbortSignal

  // Custom fetch implementation (for auth layers, proxies, etc.)
  fetchClient?: typeof fetch

  // Durable Streams read configuration
  offset?: Offset // default: start of stream (e.g. 0 or "-1")
  live?: LiveMode // default: "auto"

  // Hint: treat content as JSON even if Content-Type doesn't say so
  json?: boolean

  // Error handler for recoverable errors (following Electric client pattern)
  onError?: StreamErrorHandler
}
```

Semantics:

- `offset` → `?offset=...` query parameter.
- `live`:
  - `false` → catch-up only, stop at first `upToDate`.
  - `"long-poll"` → explicit long-poll mode for live updates.
  - `"sse"` → explicit server-sent events for live updates.
  - `"auto"` (default) → **behavior is driven by consumption method**:
    - If only `body()` / `json()` / `text()` are called: catch-up to first `upToDate`, then stop.
    - If streaming/iterator/subscriber methods are used: catch-up, then continue with long-poll.
    - (Future: may support additional heuristics for auto-selecting live mode.)

### 4.2 Chunk & batch types

```ts
export interface JsonBatchMeta {
  offset: Offset // last Stream-Next-Offset for this batch
  upToDate: boolean // based on Stream-Up-To-Date/SSE control
  cursor?: string // last Stream-Cursor / streamCursor, if present
}

export interface JsonBatch<T = unknown> extends JsonBatchMeta {
  items: readonly T[]
}

export interface ByteChunk extends JsonBatchMeta {
  data: Uint8Array
}

export interface TextChunk extends JsonBatchMeta {
  text: string
}
```

- `JsonBatch` is your zero-overhead JSON primitive: the parsed array corresponding to one HTTP response / SSE `data` event.
- `ByteChunk`/`TextChunk` carry the same metadata plus raw data.

### 4.3 `StreamResponse<TJson>` (session-side consumption)

`StreamResponse` represents one **live session** with fixed `url`, `offset`, and `live` parameters.

#### 4.3.1 Type shape

```ts
export interface StreamResponse<
  TJson = unknown,
> extends AsyncIterable<ByteChunk> {
  // --- Static session info (known after first response) ---

  readonly url: string
  readonly contentType?: string
  readonly live: LiveMode
  readonly startOffset: Offset

  // --- Evolving state as data arrives ---

  offset: Offset // last seen Stream-Next-Offset
  cursor?: string // last seen Stream-Cursor / streamCursor
  upToDate: boolean // last observed upToDate flag

  // =================================
  // 1) Accumulating helpers (Promise)
  // =================================
  // Accumulate until first `upToDate`, then resolve and stop.
  // Works with any `live` mode - these methods signal "auto" to stop at upToDate.

  /**
   * Accumulate raw bytes until first `upToDate` batch, then resolve.
   * When used with `live: "auto"`, signals the session to stop after upToDate.
   */
  body(): Promise<Uint8Array>

  /**
   * Accumulate JSON *items* across batches into a single array, resolve at `upToDate`.
   * Only valid in JSON-mode; throws otherwise.
   * When used with `live: "auto"`, signals the session to stop after upToDate.
   */
  json(): Promise<TJson[]>

  /**
   * Accumulate text chunks into a single string, resolve at `upToDate`.
   * When used with `live: "auto"`, signals the session to stop after upToDate.
   */
  text(): Promise<string>

  // =====================
  // 2) ReadableStreams
  // =====================

  /**
   * Raw bytes as a ReadableStream<Uint8Array>.
   */
  bodyStream(): ReadableStream<Uint8Array>

  /**
   * Individual JSON items (flattened) as a ReadableStream<TJson>.
   * Built on jsonBatches().
   */
  jsonStream(): ReadableStream<TJson>

  /**
   * Text chunks as ReadableStream<string>.
   */
  textStream(): ReadableStream<string>

  // =====================
  // 3) Async iterators
  // =====================

  /**
   * Default async iterator: raw byte chunks.
   * Enables `for await (const chunk of response)`.
   */
  [Symbol.asyncIterator](): AsyncIterator<ByteChunk>

  /**
   * Explicit raw byte chunks + metadata.
   */
  byteChunks(): AsyncIterable<ByteChunk>

  /**
   * JSON batches (zero-overhead arrays) + metadata.
   * Core primitive for JSON-mode streams.
   */
  jsonBatches(): AsyncIterable<JsonBatch<TJson>>

  /**
   * Flattened JSON items (per-message) for ergonomic consumption.
   */
  jsonItems(): AsyncIterable<TJson>

  /**
   * Text chunks + metadata.
   */
  textChunks(): AsyncIterable<TextChunk>

  // =====================
  // 4) Subscriber APIs
  // =====================
  // Subscribers return Promise<void> for backpressure control.
  // The next chunk is not fetched until the promise resolves.

  /**
   * Zero-overhead JSON batches; multiple subscribers share the same parsed arrays.
   * Returns unsubscribe function.
   */
  subscribeJson(
    subscriber: (batch: JsonBatch<TJson>) => Promise<void>
  ): () => void

  /**
   * Raw byte chunks; multiple subscribers share the same Uint8Array.
   * Returns unsubscribe function.
   */
  subscribeBytes(subscriber: (chunk: ByteChunk) => Promise<void>): () => void

  /**
   * Text chunks; multiple subscribers share the same string instances.
   * Returns unsubscribe function.
   */
  subscribeText(subscriber: (chunk: TextChunk) => Promise<void>): () => void

  // =====================
  // 5) Lifecycle
  // =====================

  /**
   * Cancel the underlying session (abort HTTP, close SSE, stop long-polls).
   */
  cancel(reason?: unknown): void

  /**
   * Resolves when the session has fully closed:
   * - `live:false` and up-to-date reached,
   * - manual cancellation,
   * - terminal error.
   */
  readonly closed: Promise<void>
}
```

#### 4.3.2 Session state & semi-lazy behaviour

Internal state machine:

```ts
enum SessionState {
  Connecting, // inside stream() before first response resolves/rejects
  Ready, // first response received, Response object held (body not read)
  Consuming, // at least one consumer (iterator/stream/subscriber) is active
  Closed, // completed, cancelled, or errored
}
```

- `stream(options)`:
  - Creates a new session (`Connecting`).
  - Issues the **first HTTP request**: `GET ?offset=...`
  - When the **first response** is received:
    - Validate status and headers only (do NOT read the body yet).
    - If there’s an error (4xx/5xx, bad content-type, protocol headers missing/invalid):
      - close the underlying connection,
      - reject the `stream()` promise with an error.

    - Otherwise:
      - **hold the `Response` object** (do NOT read or buffer its body yet),
      - extract `contentType`, any initial `Stream-Next-Offset`, `Stream-Up-To-Date`, `Stream-Cursor` from headers,
      - construct a `StreamResponse` object with state `Ready`,
      - resolve the promise with that `StreamResponse`.

- First consumption call (iterator/stream/subscriber/promise helper) moves `Ready → Consuming` and:
  - Starts reading the held Response body (parse JSON only when needed).
  - Determines whether to continue with live updates based on:
    - Explicit `live` mode (`false`, `"long-poll"`, `"sse"`), or
    - For `live: "auto"`: the consumption method used (see below).

- **Auto mode behavior**:
  - If `body()` / `json()` / `text()` is called: stop after first `upToDate`.
  - If streaming/iterator/subscriber methods are used: continue with long-poll after `upToDate`.

In other words:

- `stream(options)` is **eager about connection & header validation**.
- `StreamResponse` is **lazy about body consumption and live mode selection**.

#### 4.3.3 Content modes & validity

- JSON mode is enabled when:
  - `contentType` is `application/json`, or
  - the caller set `json: true` on `StreamOptions`.

JSON-specific methods (`jsonBatches`, `jsonItems`, `jsonStream`, `json`, `subscribeJson`) are:

- valid only in JSON mode;
- throw otherwise.

Promise helpers behavior:

- `body()` / `json()` / `text()` always accumulate until first `upToDate`, then resolve.
- They work with **any** `live` mode:
  - For `live: "auto"`: signals the session to stop after `upToDate` (no live updates).
  - For explicit live modes (`"long-poll"`, `"sse"`): still resolves at first `upToDate`, but the session continues in background unless cancelled.
  - For `live: false`: same behavior, session closes after `upToDate`.

#### 4.3.4 Backpressure

All consumption methods provide natural backpressure to control when the next network request is made:

- **AsyncIterators** (`byteChunks()`, `jsonBatches()`, `jsonItems()`, `textChunks()`, `for await...of`):
  - The next chunk is only fetched when `iterator.next()` is called.
  - Standard async iterator backpressure semantics apply.

- **ReadableStreams** (`bodyStream()`, `jsonStream()`, `textStream()`):
  - One chunk is pulled per `pull()` call.
  - Standard Web Streams backpressure semantics apply.
  - Compatible with `pipeTo()`, `pipeThrough()`, etc.

- **Subscribers** (`subscribeJson()`, `subscribeBytes()`, `subscribeText()`):
  - Callback returns `Promise<void>`.
  - The next chunk is **not fetched** until the promise resolves.
  - This allows the subscriber to complete any async work (e.g., database writes, UI updates) before receiving more data.

- **Promise helpers** (`body()`, `json()`, `text()`):
  - No backpressure needed—they accumulate to first `upToDate` and resolve once.

This means the client never buffers unbounded data in memory. Network requests are paced by the consumer's ability to process data.

---

## 5. Top-level `stream(options)` API

Signature:

```ts
export async function stream<TJson = unknown>(
  options: StreamOptions
): Promise<StreamResponse<TJson>>
```

Behaviour:

1. Build request URL and headers according to `StreamOptions`.
2. Start the **first** HTTP request: `GET ?offset=...`
3. If that request fails (network issue, auth, 404, 500, protocol error):
   - reject the promise with an appropriate error.

4. If it succeeds:
   - **hold the `Response` object** (do NOT read the body yet),
   - extract `contentType`, and initial `offset` / `cursor` / `upToDate` from headers,
   - construct a `StreamResponse` bound to the underlying session,
   - resolve the promise with that `StreamResponse`.

This is fetch-like in two key ways:

- **`await` gives you errors early** (auth, missing stream, protocol).
- You get a **response object you can consume in different ways**: promises, streams, iterators, subscribers.

Usage examples:

```ts
// Catch-up JSON:
const res = await stream<{ message: string }>({
  url,
  auth,
  offset: "0",
  live: false,
})

const items = await res.json()
persistOffset(res.offset)

// Live JSON:
const live = await stream<{ message: string }>({
  url,
  auth,
  offset: savedOffset,
  live: "auto",
})

for await (const item of live.jsonItems()) {
  handle(item)
  persistOffset(live.offset)
}
```

---

## 6. Handle API Design (`StreamHandle`)

We replace `DurableStream` with `StreamHandle`.

### 6.1 Types

```ts
export interface StreamHandleOptions {
  url: string | URL
  auth?: AuthOptions
  contentType?: string
  onError?: OnErrorHandler
}

export interface CreateOptions extends StreamHandleOptions {
  ttlSeconds?: number
  expiresAt?: string // RFC3339 timestamp
}

export interface HeadResult {
  contentType: string
  offset: Offset // tail offset
  ttlSeconds?: number
  expiresAt?: string
}

export interface AppendOptions {
  signal?: AbortSignal
  // (other per-append options as needed)
}
```

### 6.2 StreamHandle class

```ts
export class StreamHandle {
  readonly url: string
  readonly contentType?: string

  constructor(opts: StreamHandleOptions)

  // --- Static methods ---

  static async create(opts: CreateOptions): Promise<StreamHandle>
  static async connect(opts: StreamHandleOptions): Promise<StreamHandle>
  static async head(opts: StreamHandleOptions): Promise<HeadResult>
  static async delete(opts: StreamHandleOptions): Promise<void>

  // --- Instance metadata / lifecycle ---

  head(opts?: { signal?: AbortSignal }): Promise<HeadResult>
  create(opts?: Omit<CreateOptions, "url">): Promise<void>
  delete(opts?: { signal?: AbortSignal }): Promise<void>

  // --- Writes ---

  append(
    body: BodyInit | Uint8Array | string | unknown, // keep JSON convenience
    opts?: AppendOptions
  ): Promise<void>

  appendStream(
    source: AsyncIterable<Uint8Array | string | unknown>,
    opts?: AppendOptions
  ): Promise<void>

  // --- Read session factory ---

  /**
   * Start a fetch-like streaming session against this handle’s URL/auth.
   * The first request is made inside this method; it resolves when we have
   * a valid first response, or rejects on errors.
   */
  stream<TJson = unknown>(
    options?: Omit<StreamOptions, "url" | "auth">
  ): Promise<StreamResponse<TJson>>
}
```

Usage:

```ts
// Writer code:
const handle = await StreamHandle.create({
  url,
  auth,
  contentType: "application/json",
})

await handle.append({ type: "message", text: "hello" })

// Reader code using handle:
const res = await handle.stream<{ type: string; text: string }>({
  offset: "-1",
  live: "auto",
})

for await (const item of res.jsonItems()) {
  console.log(item)
}
```

### 6.3 Relationship with top-level `stream()`

The top-level `stream()` is a **lightweight, standalone implementation**:

```ts
export async function stream<TJson = unknown>(
  options: StreamOptions
): Promise<StreamResponse<TJson>> {
  // Lightweight internal implementation:
  // - Does NOT use or depend on StreamHandle
  // - Directly runs the first request and constructs a StreamResponse
  // - Shared core logic with StreamHandle.stream()
}
```

Both `stream()` and `StreamHandle.stream()` share the same underlying implementation for making requests and constructing `StreamResponse` objects. The top-level `stream()` is simply a convenience for read-only use cases.

---

## 7. Old → New Mapping

Showing how old `DurableStream` usage maps to the new world.

### 7.1 Read-only usage

**Old:**

```ts
const s = await DurableStream.connect({ url, auth })

for await (const chunk of s.read({ offset, live: "auto" })) {
  processChunk(chunk)
}
```

**New (client only):**

```ts
const res = await stream({ url, auth, offset, live: "auto" })

for await (const chunk of res.byteChunks()) {
  processChunk(chunk.data)
}
```

### 7.2 JSON read

**Old:**

```ts
const s = await DurableStream.connect({ url, auth })

for await (const item of s.json({ live: false })) {
  apply(item)
}
```

**New:**

```ts
const res = await stream({ url, auth, live: false })

const items = await res.json()
// or:
for await (const item of res.jsonItems()) {
  apply(item)
}
```

### 7.3 ReadableStream usage

**Old:**

```ts
const s = await DurableStream.connect({ url, auth })
const rs = s.toByteStream({ offset, live: "auto" })
await rs.pipeTo(destination)
```

**New:**

```ts
const res = await stream({ url, auth, offset, live: "auto" })
const rs = res.bodyStream()
await rs.pipeTo(destination)
```

### 7.4 Writes

**Old:**

```ts
const s = await DurableStream.create({ url, auth, contentType })
await s.append(JSON.stringify(payload))
```

**New:**

```ts
const handle = await StreamHandle.create({ url, auth, contentType })
await handle.append(payload) // JSON convenience
```

---

## 8. Summary of the key changes

- `DurableStream` → **two APIs** (both in `@durable-streams/client`):
  - `stream(options): Promise<StreamResponse>` for **read-only** use cases.
  - `StreamHandle` for **writes and lifecycle**, with `.stream()` to start a read session.

- `stream()` is now **fetch-like**:
  - it performs the **first network request inside the function**,
  - it **rejects** early on auth/404/protocol errors,
  - it **resolves** to a `StreamResponse` only after validating the first response headers,
  - the `Response` object is **held but not consumed** until the user calls a consumption method.

- `StreamResponse` is the central abstraction for reads:
  - exposes `offset`, `cursor`, `upToDate`,
  - supports **Promise**, **ReadableStream**, **AsyncIterable**, and **subscriber** styles,
  - has explicit JSON mode and zero-overhead JSON batch APIs.

- **`live: "auto"` is default** and behavior is driven by consumption method:
  - `body()` / `json()` / `text()`: accumulate to first `upToDate`, then stop.
  - Streaming/iterator/subscriber methods: catch-up, then continue with long-poll.

- **Backpressure** is built into all consumption methods:
  - Iterators/streams pace network requests based on consumer speed.
  - Subscribers return `Promise<void>` to signal readiness for next chunk.

- **Customizable fetch** via `fetchClient` option for auth layers, proxies, etc.
- **Error handling preserved** via `onError` callback in `StreamOptions`.

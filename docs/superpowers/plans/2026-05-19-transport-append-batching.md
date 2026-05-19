# Transport Append Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #355 by making the AI SDK and TanStack AI transports engage the client's built-in batching when writing an async iterable to a durable stream, eliminating one-POST-per-chunk tail latency.

**Architecture:** The client's `DurableStream.append()` already batches concurrent (non-awaited) callers via an internal `fastq` queue. The transports serialize each chunk with `await stream.append(...)`, which keeps the queue idle and defeats batching. Fix: each transport's `writeSourceToStream` fires `append()` without awaiting per-chunk, tracks the latest pending promise (and any rejection) via `.catch`, and drains by awaiting that promise before `stream.close()`. Update README examples that teach the slow pattern. Add focused unit tests in each transport that mock `DurableStream` and verify the loop does not stall on `append()` resolution.

**Tech Stack:** TypeScript, vitest, fastq (existing client dependency), pnpm workspace, changesets.

---

## Background — exact current state

Issue: https://github.com/durable-streams/durable-streams/issues/355

Current offending loops (both have identical shape):

- `packages/aisdk-transport/src/server.ts:53-54`
- `packages/tanstack-ai-transport/src/server.ts:92-93`
- `packages/tanstack-ai-transport/src/server.ts:194-204` (`pipeSanitizedChunksToStream`)
- `packages/tanstack-ai-transport/src/server.ts:182-192` (`appendSanitizedChunksToStream` — same pattern for a known-length array)

Client batching internals (read-only context):

- `packages/client/src/stream.ts:155` (`#buffer`), `:177` (`fastq.promise(..., 1)`), `:465-476` (`append` dispatch), `:534-588` (`#appendWithBatching` + `#batchWorker`).

Existing tests for tanstack-ai-transport: `packages/tanstack-ai-transport/test/session-transport.test.ts` (mocks `@durable-streams/client` via `vi.hoisted`). aisdk-transport currently has no tests; the root `vitest.config.ts` will need a new project entry.

Docs that teach the slow pattern:

- `packages/client/src/stream.ts:125` (JSDoc on the class), `:455-459` (JSDoc on `append`)
- `packages/client/README.md:1133`
- `docs/stream-db.md:152,181,199,218-220,250` (note: these are correct usage for StateDB; do **not** modify — StateDB is the consumer there, not the AI transports)

---

## File Structure

**Modify:**

- `packages/aisdk-transport/src/server.ts` — rewrite `writeSourceToStream` to fire-and-track-last
- `packages/aisdk-transport/package.json` — add `vitest` devDep and `test` script
- `packages/aisdk-transport/README.md` — fix README example if it teaches per-chunk await
- `packages/tanstack-ai-transport/src/server.ts` — rewrite `writeSourceToStream`, `pipeSanitizedChunksToStream`, `appendSanitizedChunksToStream`
- `packages/client/src/stream.ts` — adjust JSDoc examples at `:115-134` and `:452-464` to recommend `appendStream`/`writable` for tight loops and explain batching
- `packages/client/README.md` — same JSDoc improvements around line 1133
- `vitest.config.ts` (root) — add `aisdk-transport` project
- `.changeset/` — add a single patch changeset covering both transports + client docs

**Create:**

- `packages/aisdk-transport/test/server.test.ts` — unit tests for new `writeSourceToStream`
- `packages/tanstack-ai-transport/test/server.test.ts` — unit tests for the three modified server helpers

**No changes:**

- `packages/client/src/stream.ts` runtime behaviour — the fix lives in the transports.
- Conformance tests — this is transport behaviour, not protocol behaviour; the per-language client conformance suite doesn't exercise these transports. (See CLAUDE.md's testing philosophy: conformance tests verify the protocol; these are TS-only transport adapters.)

---

## Task 1: Add aisdk-transport to vitest workspace + package scripts

**Files:**

- Modify: `vitest.config.ts` (root)
- Modify: `packages/aisdk-transport/package.json`

- [ ] **Step 1: Add aisdk-transport project to root vitest workspace**

In `vitest.config.ts`, after the existing `tanstack-transport` project block (last entry before the closing `]`), add:

```ts
      defineProject({
        test: {
          name: "aisdk-transport",
          include: ["packages/aisdk-transport/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
        },
        resolve: { alias },
      }),
```

- [ ] **Step 2: Add `test` script and vitest devDep to aisdk-transport**

In `packages/aisdk-transport/package.json`:

1. Add a `test` script alongside the existing scripts:

```json
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
```

2. Add `vitest` to `devDependencies` (use the same version range the root uses — `^4.0.0`):

```json
  "devDependencies": {
    "@tanstack/intent": "latest",
    "ai": "latest",
    "tsdown": "^0.9.0",
    "vitest": "^4.0.0"
  },
```

- [ ] **Step 3: Install + verify workspace resolution**

Run: `pnpm install`
Expected: completes without errors; `vitest` resolves in `packages/aisdk-transport`.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts packages/aisdk-transport/package.json pnpm-lock.yaml
git commit -m "chore(aisdk-transport): wire up vitest workspace project"
```

---

## Task 2: TanStack — failing test for non-blocking append loop

**Files:**

- Create: `packages/tanstack-ai-transport/test/server.test.ts`

We assert that the rewritten `writeSourceToStream` does NOT wait for each `append()` to resolve before pulling the next chunk from the source. The test holds all `append()` calls pending until the source iterator finishes, then resolves them all — proving the loop ran ahead of `append`.

- [ ] **Step 1: Write the failing test file**

Create `packages/tanstack-ai-transport/test/server.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"

const { appendMock, closeMock, MockDurableStream, MockDurableStreamError } =
  vi.hoisted(() => {
    const appendMock = vi.fn()
    const closeMock = vi.fn()

    class MockDurableStream {
      constructor(_opts: any) {}
      create() {
        return Promise.resolve()
      }
      append(...args: Array<any>) {
        return appendMock(...args)
      }
      close(...args: Array<any>) {
        return closeMock(...args)
      }
    }

    class MockDurableStreamError extends Error {
      status?: number
      code?: string
      constructor(message: string, opts?: { status?: number; code?: string }) {
        super(message)
        this.status = opts?.status
        this.code = opts?.code
      }
    }

    return { appendMock, closeMock, MockDurableStream, MockDurableStreamError }
  })

vi.mock(`@durable-streams/client`, () => ({
  DurableStream: MockDurableStream,
  DurableStreamError: MockDurableStreamError,
}))

import {
  appendSanitizedChunksToStream,
  pipeSanitizedChunksToStream,
  toDurableStreamResponse,
} from "../src/server"

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe(`tanstack-ai-transport writeSourceToStream batching`, () => {
  it(`does not block source iteration on append() resolution`, async () => {
    appendMock.mockReset()
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    const pendings: Array<ReturnType<typeof deferred>> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise
    })

    let produced = 0
    const source = (async function* () {
      for (let i = 0; i < 5; i++) {
        produced++
        yield { type: `TEXT_MESSAGE_CONTENT`, delta: `chunk-${i}` }
      }
    })()

    const responsePromise = toDurableStreamResponse(source, {
      stream: {
        writeUrl: `https://example.com/s`,
        readUrl: `https://example.com/s`,
        createIfMissing: false,
      },
      mode: `await`,
    })

    // Yield to let the iterator run. With per-chunk await, only 1 append
    // is pending. With the new non-blocking loop, all 5 should be pending.
    await new Promise((r) => setTimeout(r, 0))

    expect(produced).toBe(5)
    expect(appendMock).toHaveBeenCalledTimes(5)

    for (const d of pendings) d.resolve()
    const response = await responsePromise
    expect(response.status).toBe(200)
  })

  it(`awaits all pending appends before close()`, async () => {
    appendMock.mockReset()
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    let closeCalledAt = -1
    let appendsResolvedAt = -1
    let tick = 0

    const pendings: Array<ReturnType<typeof deferred>> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise.then(() => {
        appendsResolvedAt = tick++
      })
    })
    closeMock.mockImplementation(() => {
      closeCalledAt = tick++
      return Promise.resolve({ finalOffset: `0` })
    })

    const source = (async function* () {
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `a` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `b` }
    })()

    const responsePromise = toDurableStreamResponse(source, {
      stream: { writeUrl: `https://example.com/s`, createIfMissing: false },
      mode: `await`,
    })

    await new Promise((r) => setTimeout(r, 0))
    // Resolve appends only after a delay; close must wait.
    queueMicrotask(() => {
      for (const d of pendings) d.resolve()
    })

    await responsePromise
    expect(appendsResolvedAt).toBeGreaterThanOrEqual(0)
    expect(closeCalledAt).toBeGreaterThan(appendsResolvedAt)
  })

  it(`surfaces append errors from the latest pending promise`, async () => {
    appendMock.mockReset()
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    appendMock.mockImplementationOnce(() => Promise.resolve())
    appendMock.mockImplementationOnce(() => Promise.reject(new Error(`boom`)))

    const source = (async function* () {
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `a` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `b` }
    })()

    await expect(
      toDurableStreamResponse(source, {
        stream: { writeUrl: `https://example.com/s`, createIfMissing: false },
        mode: `await`,
      })
    ).rejects.toThrow(/boom/)

    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})

describe(`tanstack-ai-transport pipeSanitizedChunksToStream batching`, () => {
  it(`does not block on append()`, async () => {
    appendMock.mockReset()
    const pendings: Array<ReturnType<typeof deferred>> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise
    })

    const source = (async function* () {
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `a` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `b` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `c` }
    })()

    const stream = new MockDurableStream({ url: `x` }) as any
    const done = pipeSanitizedChunksToStream(source, stream)

    await new Promise((r) => setTimeout(r, 0))
    expect(appendMock).toHaveBeenCalledTimes(3)

    for (const d of pendings) d.resolve()
    await done
  })
})

describe(`tanstack-ai-transport appendSanitizedChunksToStream batching`, () => {
  it(`fires all appends without per-item blocking`, async () => {
    appendMock.mockReset()
    const pendings: Array<ReturnType<typeof deferred>> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise
    })

    const stream = new MockDurableStream({ url: `x` }) as any
    const chunks = [
      { type: `TEXT_MESSAGE_START`, messageId: `m1`, role: `user` as const },
      { type: `TEXT_MESSAGE_END`, messageId: `m1` },
    ]
    const done = appendSanitizedChunksToStream(stream, chunks as any)
    await new Promise((r) => setTimeout(r, 0))
    expect(appendMock).toHaveBeenCalledTimes(2)
    for (const d of pendings) d.resolve()
    await done
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project tanstack-transport packages/tanstack-ai-transport/test/server.test.ts`

Expected: `does not block source iteration on append() resolution` fails — `appendMock` is called 1 time, expected 5 — because the current `for await ... await stream.append(...)` loop only fires one POST at a time.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/tanstack-ai-transport/test/server.test.ts
git commit -m "test(tanstack-ai-transport): failing tests for non-blocking append loop"
```

---

## Task 3: TanStack — implement non-blocking append loop

**Files:**

- Modify: `packages/tanstack-ai-transport/src/server.ts:84-117` (`writeSourceToStream`)
- Modify: `packages/tanstack-ai-transport/src/server.ts:182-192` (`appendSanitizedChunksToStream`)
- Modify: `packages/tanstack-ai-transport/src/server.ts:194-204` (`pipeSanitizedChunksToStream`)

The pattern: track `lastAppend` as the latest `append()` promise. Attach a `.catch` to capture any rejection in a closure variable so the unhandled-rejection slot is consumed. After the source loop, await `lastAppend` (and rethrow any captured error) before closing.

- [ ] **Step 1: Replace `writeSourceToStream`**

Find at `packages/tanstack-ai-transport/src/server.ts:84-117`:

```ts
async function writeSourceToStream(
  source: AsyncIterable<unknown>,
  stream: DurableStream,
  contentType: string
): Promise<string> {
  let finalOffset = ``
  let sourceError: unknown = undefined
  try {
    for await (const chunk of source) {
      await stream.append(JSON.stringify(chunk), { contentType })
    }
  } catch (error) {
    sourceError = error
  } finally {
    // Always close so readers can terminate loading state.
    try {
      const closeResult = await stream.close()
      finalOffset = closeResult.finalOffset
    } catch (error) {
      if (
        !(
          error instanceof DurableStreamError && error.code === `STREAM_CLOSED`
        ) &&
        sourceError === undefined
      ) {
        sourceError = error
      }
    }
  }
  if (sourceError !== undefined) {
    throw sourceError
  }
  return finalOffset
}
```

Replace with:

```ts
async function writeSourceToStream(
  source: AsyncIterable<unknown>,
  stream: DurableStream,
  contentType: string
): Promise<string> {
  let finalOffset = ``
  let sourceError: unknown = undefined
  let appendError: unknown = undefined
  let lastAppend: Promise<void> = Promise.resolve()

  const trackAppend = (p: Promise<void>): Promise<void> => {
    const tracked = p.catch((err) => {
      if (appendError === undefined) appendError = err
    })
    lastAppend = tracked
    return tracked
  }

  try {
    for await (const chunk of source) {
      if (appendError !== undefined) break
      trackAppend(stream.append(JSON.stringify(chunk), { contentType }))
    }
  } catch (error) {
    sourceError = error
  } finally {
    // Drain pending appends; queue is FIFO + concurrency 1, so awaiting
    // the latest tracked promise also awaits everything before it.
    await lastAppend
    try {
      const closeResult = await stream.close()
      finalOffset = closeResult.finalOffset
    } catch (error) {
      if (
        !(
          error instanceof DurableStreamError && error.code === `STREAM_CLOSED`
        ) &&
        sourceError === undefined &&
        appendError === undefined
      ) {
        sourceError = error
      }
    }
  }
  if (appendError !== undefined) {
    throw appendError
  }
  if (sourceError !== undefined) {
    throw sourceError
  }
  return finalOffset
}
```

- [ ] **Step 2: Replace `appendSanitizedChunksToStream` and `pipeSanitizedChunksToStream`**

Find at `packages/tanstack-ai-transport/src/server.ts:182-204`:

```ts
export async function appendSanitizedChunksToStream(
  stream: DurableStream,
  chunks: ReadonlyArray<TanStackChunk>,
  contentType: string = DEFAULT_CONTENT_TYPE
): Promise<void> {
  for (const chunk of chunks) {
    await stream.append(JSON.stringify(sanitizeChunkForStorage(chunk)), {
      contentType,
    })
  }
}

export async function pipeSanitizedChunksToStream(
  source: AsyncIterable<TanStackChunk>,
  stream: DurableStream,
  contentType: string = DEFAULT_CONTENT_TYPE
): Promise<void> {
  for await (const chunk of source) {
    await stream.append(JSON.stringify(sanitizeChunkForStorage(chunk)), {
      contentType,
    })
  }
}
```

Replace with:

```ts
export async function appendSanitizedChunksToStream(
  stream: DurableStream,
  chunks: ReadonlyArray<TanStackChunk>,
  contentType: string = DEFAULT_CONTENT_TYPE
): Promise<void> {
  let appendError: unknown = undefined
  let lastAppend: Promise<void> = Promise.resolve()
  for (const chunk of chunks) {
    if (appendError !== undefined) break
    lastAppend = stream
      .append(JSON.stringify(sanitizeChunkForStorage(chunk)), { contentType })
      .catch((err) => {
        if (appendError === undefined) appendError = err
      })
  }
  await lastAppend
  if (appendError !== undefined) throw appendError
}

export async function pipeSanitizedChunksToStream(
  source: AsyncIterable<TanStackChunk>,
  stream: DurableStream,
  contentType: string = DEFAULT_CONTENT_TYPE
): Promise<void> {
  let appendError: unknown = undefined
  let lastAppend: Promise<void> = Promise.resolve()
  try {
    for await (const chunk of source) {
      if (appendError !== undefined) break
      lastAppend = stream
        .append(JSON.stringify(sanitizeChunkForStorage(chunk)), { contentType })
        .catch((err) => {
          if (appendError === undefined) appendError = err
        })
    }
  } finally {
    await lastAppend
  }
  if (appendError !== undefined) throw appendError
}
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm vitest run --project tanstack-transport`

Expected: all 5 tests in `server.test.ts` pass; the pre-existing `session-transport.test.ts` still passes.

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter @durable-streams/tanstack-ai-transport typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/tanstack-ai-transport/src/server.ts
git commit -m "fix(tanstack-ai-transport): engage client batching by not awaiting each append"
```

---

## Task 4: AI SDK — failing test for non-blocking append loop

**Files:**

- Create: `packages/aisdk-transport/test/server.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/aisdk-transport/test/server.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"

const {
  appendMock,
  closeMock,
  createMock,
  MockDurableStream,
  MockDurableStreamError,
} = vi.hoisted(() => {
  const appendMock = vi.fn()
  const closeMock = vi.fn()
  const createMock = vi.fn()

  class MockDurableStream {
    constructor(_opts: any) {}
    create(...args: Array<any>) {
      return createMock(...args)
    }
    append(...args: Array<any>) {
      return appendMock(...args)
    }
    close(...args: Array<any>) {
      return closeMock(...args)
    }
  }

  class MockDurableStreamError extends Error {
    status?: number
    code?: string
    constructor(message: string, opts?: { status?: number; code?: string }) {
      super(message)
      this.status = opts?.status
      this.code = opts?.code
    }
  }

  return {
    appendMock,
    closeMock,
    createMock,
    MockDurableStream,
    MockDurableStreamError,
  }
})

vi.mock(`@durable-streams/client`, () => ({
  DurableStream: MockDurableStream,
  DurableStreamError: MockDurableStreamError,
}))

import { toDurableStreamResponse } from "../src/server"

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe(`aisdk-transport writeSourceToStream batching`, () => {
  it(`does not block source iteration on append() resolution`, async () => {
    appendMock.mockReset()
    createMock.mockReset().mockResolvedValue(undefined)
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    const pendings: Array<ReturnType<typeof deferred>> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise
    })

    let produced = 0
    const source = (async function* () {
      for (let i = 0; i < 5; i++) {
        produced++
        yield { type: `text-delta`, text: `chunk-${i}` }
      }
    })()

    const responsePromise = toDurableStreamResponse({
      source,
      stream: {
        writeUrl: `https://example.com/s`,
        readUrl: `https://example.com/s`,
      },
      mode: `await`,
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(produced).toBe(5)
    expect(appendMock).toHaveBeenCalledTimes(5)

    for (const d of pendings) d.resolve()
    const response = await responsePromise
    expect(response.status).toBe(200)
  })

  it(`awaits pending appends before close()`, async () => {
    appendMock.mockReset()
    createMock.mockReset().mockResolvedValue(undefined)
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    let appendsResolvedAt = -1
    let closeCalledAt = -1
    let tick = 0

    const pendings: Array<ReturnType<typeof deferred>> = []
    appendMock.mockImplementation(() =>
      new Promise<void>((resolve) => {
        pendings.push({
          promise: Promise.resolve(),
          resolve: () => resolve(),
          reject: () => {},
        })
      }).then(() => {
        appendsResolvedAt = tick++
      })
    )
    closeMock.mockImplementation(() => {
      closeCalledAt = tick++
      return Promise.resolve({ finalOffset: `0` })
    })

    const source = (async function* () {
      yield { type: `text-delta`, text: `a` }
      yield { type: `text-delta`, text: `b` }
    })()

    const responsePromise = toDurableStreamResponse({
      source,
      stream: { writeUrl: `https://example.com/s` },
      mode: `await`,
    })

    await new Promise((r) => setTimeout(r, 0))
    queueMicrotask(() => {
      for (const d of pendings) d.resolve()
    })

    await responsePromise
    expect(appendsResolvedAt).toBeGreaterThanOrEqual(0)
    expect(closeCalledAt).toBeGreaterThan(appendsResolvedAt)
  })

  it(`surfaces append errors`, async () => {
    appendMock.mockReset()
    createMock.mockReset().mockResolvedValue(undefined)
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    appendMock.mockImplementationOnce(() => Promise.resolve())
    appendMock.mockImplementationOnce(() => Promise.reject(new Error(`boom`)))

    const source = (async function* () {
      yield { type: `text-delta`, text: `a` }
      yield { type: `text-delta`, text: `b` }
    })()

    await expect(
      toDurableStreamResponse({
        source,
        stream: { writeUrl: `https://example.com/s` },
        mode: `await`,
      })
    ).rejects.toThrow(/boom/)

    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project aisdk-transport`

Expected: the first test fails — `appendMock` called 1 time, expected 5.

- [ ] **Step 3: Commit**

```bash
git add packages/aisdk-transport/test/server.test.ts
git commit -m "test(aisdk-transport): failing tests for non-blocking append loop"
```

---

## Task 5: AI SDK — implement non-blocking append loop

**Files:**

- Modify: `packages/aisdk-transport/src/server.ts:45-78` (`writeSourceToStream`)

- [ ] **Step 1: Replace `writeSourceToStream`**

Find at `packages/aisdk-transport/src/server.ts:45-78`:

```ts
async function writeSourceToStream(
  source: AsyncIterable<unknown>,
  stream: DurableStream,
  contentType: string
): Promise<string> {
  let finalOffset = ``
  let sourceError: unknown = undefined
  try {
    for await (const chunk of source) {
      await stream.append(JSON.stringify(chunk), { contentType })
    }
  } catch (error) {
    sourceError = error
  } finally {
    try {
      const closeResult = await stream.close()
      finalOffset = closeResult.finalOffset
    } catch (error) {
      if (
        !(
          error instanceof DurableStreamError && error.code === `STREAM_CLOSED`
        ) &&
        sourceError === undefined
      ) {
        sourceError = error
      }
    }
  }

  if (sourceError !== undefined) {
    throw sourceError
  }
  return finalOffset
}
```

Replace with:

```ts
async function writeSourceToStream(
  source: AsyncIterable<unknown>,
  stream: DurableStream,
  contentType: string
): Promise<string> {
  let finalOffset = ``
  let sourceError: unknown = undefined
  let appendError: unknown = undefined
  let lastAppend: Promise<void> = Promise.resolve()

  try {
    for await (const chunk of source) {
      if (appendError !== undefined) break
      lastAppend = stream
        .append(JSON.stringify(chunk), { contentType })
        .catch((err) => {
          if (appendError === undefined) appendError = err
        })
    }
  } catch (error) {
    sourceError = error
  } finally {
    // Drain queued appends before closing. The client queue is FIFO with
    // concurrency 1, so awaiting the last tracked promise drains all prior ones.
    await lastAppend
    try {
      const closeResult = await stream.close()
      finalOffset = closeResult.finalOffset
    } catch (error) {
      if (
        !(
          error instanceof DurableStreamError && error.code === `STREAM_CLOSED`
        ) &&
        sourceError === undefined &&
        appendError === undefined
      ) {
        sourceError = error
      }
    }
  }

  if (appendError !== undefined) {
    throw appendError
  }
  if (sourceError !== undefined) {
    throw sourceError
  }
  return finalOffset
}
```

- [ ] **Step 2: Run the tests and confirm they pass**

Run: `pnpm vitest run --project aisdk-transport`
Expected: all 3 tests pass.

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @durable-streams/aisdk-transport typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/aisdk-transport/src/server.ts
git commit -m "fix(aisdk-transport): engage client batching by not awaiting each append"
```

---

## Task 6: Update client docs that teach the slow pattern

**Files:**

- Modify: `packages/client/src/stream.ts:115-134` (class JSDoc) and `:452-464` (append JSDoc)
- Modify: `packages/client/README.md` around `:1133`

The current JSDoc shows `await stream.append(JSON.stringify({ message: "hello" }))` with no warning. The fix is to add a short note about batching semantics and point tight-loop use cases at `appendStream`/`writable`.

- [ ] **Step 1: Update class-level JSDoc example in `stream.ts`**

Find at `packages/client/src/stream.ts:115-134`:

````ts
/**
 * A handle to a remote durable stream for read/write operations.
 *
 * This is a lightweight, reusable handle - not a persistent connection.
 * It does not automatically start reading or listening.
 * Create sessions as needed via stream().
 *
 * @example
 * ```typescript
 * // Create a new stream
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   headers: { Authorization: "Bearer my-token" },
 *   contentType: "application/json"
 * });
 *
 * // Write data
 * await stream.append(JSON.stringify({ message: "hello" }));
 *
 * // Read with the new API
 * const res = await stream.stream<{ message: string }>();
 * res.subscribeJson(async (batch) => {
 *   for (const item of batch.items) {
 *     console.log(item.message);
 *   }
 * });
 * ```
 */
````

Replace with:

````ts
/**
 * A handle to a remote durable stream for read/write operations.
 *
 * This is a lightweight, reusable handle - not a persistent connection.
 * It does not automatically start reading or listening.
 * Create sessions as needed via stream().
 *
 * @example
 * ```typescript
 * // Create a new stream
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   headers: { Authorization: "Bearer my-token" },
 *   contentType: "application/json"
 * });
 *
 * // Single write
 * await stream.append(JSON.stringify({ message: "hello" }));
 *
 * // Read with the new API
 * const res = await stream.stream<{ message: string }>();
 * res.subscribeJson(async (batch) => {
 *   for (const item of batch.items) {
 *     console.log(item.message);
 *   }
 * });
 * ```
 */
````

(This change is just the comment "Write data" → "Single write" — the substantive guidance lives on `append()` and is referenced from there.)

- [ ] **Step 2: Update `append()` JSDoc to document batching engagement**

Find at `packages/client/src/stream.ts:439-464`:

````ts
/**
 * Append a single payload to the stream.
 *
 * When batching is enabled (default), multiple append() calls made while
 * a POST is in-flight will be batched together into a single request.
 * This significantly improves throughput for high-frequency writes.
 *
 * - `body` must be string or Uint8Array.
 * - For JSON streams, pass pre-serialized JSON strings.
 * - `body` may also be a Promise that resolves to string or Uint8Array.
 * - Strings are encoded as UTF-8.
 * - `seq` (if provided) is sent as stream-seq (writer coordination).
 *
 * @example
 * ```typescript
 * // JSON stream - pass pre-serialized JSON
 * await stream.append(JSON.stringify({ message: "hello" }));
 *
 * // Byte stream
 * await stream.append("raw text data");
 * await stream.append(new Uint8Array([1, 2, 3]));
 *
 * // Promise value - awaited before buffering
 * await stream.append(fetchData());
 * ```
 */
````

Replace with:

````ts
/**
 * Append a single payload to the stream.
 *
 * Batching: when batching is enabled (default), append() calls that overlap
 * in time (e.g. fired without awaiting each one) are coalesced into a
 * single POST while a prior POST is in flight. If every call is awaited
 * before the next is issued, no batching happens — each call becomes its
 * own roundtrip. For tight loops driving an async iterable (e.g. LLM
 * token streams), prefer `appendStream()` / `writable()` which pipe the
 * source over a single POST, or fire `append()` calls without awaiting
 * each one and await the last promise (and `close()`) at the end.
 *
 * - `body` must be string or Uint8Array.
 * - For JSON streams, pass pre-serialized JSON strings.
 * - `body` may also be a Promise that resolves to string or Uint8Array.
 * - Strings are encoded as UTF-8.
 * - `seq` (if provided) is sent as stream-seq (writer coordination).
 *
 * @example
 * ```typescript
 * // JSON stream - pass pre-serialized JSON (single write)
 * await stream.append(JSON.stringify({ message: "hello" }));
 *
 * // Byte stream
 * await stream.append("raw text data");
 * await stream.append(new Uint8Array([1, 2, 3]));
 *
 * // Promise value - awaited before buffering
 * await stream.append(fetchData());
 *
 * // High-frequency writes from an async iterable - fire-and-track-last
 * let last: Promise<void> = Promise.resolve();
 * for await (const chunk of source) {
 *   last = stream.append(JSON.stringify(chunk));
 * }
 * await last;
 * await stream.close();
 * ```
 */
````

- [ ] **Step 3: Update `packages/client/README.md`**

Find at `packages/client/README.md:1133` (and surrounding context — grep the file to locate the example). The example currently reads:

```ts
await stream.append("data")
```

Add a short note after the example block that introduces batching. Use Read to view 30 lines around `:1133` first, then edit to add a note like:

```md
> **Performance note:** `append()` calls that overlap in time (fired without
> awaiting) are batched into a single POST by default. If you `await` every
> call inside a tight loop the batching never engages. For loops over an
> async iterable (e.g. LLM streams), prefer `appendStream()` / `writable()`,
> or fire `append()` without awaiting and await only the last promise (and
> `close()`) at the end.
```

- [ ] **Step 4: Verify typecheck still passes**

Run: `pnpm --filter @durable-streams/client typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/stream.ts packages/client/README.md
git commit -m "docs(client): warn against per-chunk awaited append() in tight loops"
```

---

## Task 7: Update aisdk-transport and tanstack-ai-transport READMEs if they teach the slow pattern

**Files:**

- Read: `packages/aisdk-transport/README.md`
- Read: `packages/tanstack-ai-transport/README.md`
- Modify (conditional): same files if they contain a `for await … await stream.append` example

- [ ] **Step 1: Inspect both READMEs**

Run:

```bash
grep -n "stream.append\|for await" packages/aisdk-transport/README.md packages/tanstack-ai-transport/README.md
```

- [ ] **Step 2: If either README contains a hand-rolled `for await ... await stream.append(...)` example, replace it**

Replace such an example with a reference to `toDurableStreamResponse` (which is the supported entrypoint and now does the right thing internally). For example, if a README shows:

```ts
for await (const chunk of source) {
  await stream.append(JSON.stringify(chunk))
}
```

Replace with:

```ts
// Use the supported transport entrypoint — it handles batching internally.
return toDurableStreamResponse({ source, stream: { writeUrl } })
```

If no such example exists, skip this step.

- [ ] **Step 3: Commit if anything changed**

```bash
git add packages/aisdk-transport/README.md packages/tanstack-ai-transport/README.md
git commit -m "docs(transports): drop hand-rolled append loop in README examples"
```

If no diff, skip the commit.

---

## Task 8: Add changeset

**Files:**

- Create: `.changeset/transport-append-batching.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/transport-append-batching.md`:

```md
---
"@durable-streams/aisdk-transport": patch
"@durable-streams/tanstack-ai-transport": patch
"@durable-streams/client": patch
---

Engage client-side batching in AI SDK and TanStack AI transport response
writers. The transports previously awaited every `stream.append(...)` call
inside the source loop, which kept the client's internal batch queue idle
and turned every chunk into its own POST. The writers now fire-and-track
appends and drain pending writes before closing, restoring batching for
high-frequency token streams. Documents the batching engagement contract
on `DurableStream.append()` so library users don't reintroduce the pattern.
```

- [ ] **Step 2: Verify changeset is picked up**

Run: `pnpm changeset status`
Expected: lists the three packages with patch bumps.

- [ ] **Step 3: Commit**

```bash
git add .changeset/transport-append-batching.md
git commit -m "chore: changeset for transport batching fix"
```

---

## Task 9: Full verification

**Files:** none

- [ ] **Step 1: Run all unit tests**

Run: `pnpm test:run`
Expected: all projects pass, including `aisdk-transport`, `tanstack-transport`, and `client`.

- [ ] **Step 2: Run typecheck across affected packages**

Run:

```bash
pnpm --filter @durable-streams/client typecheck
pnpm --filter @durable-streams/aisdk-transport typecheck
pnpm --filter @durable-streams/tanstack-ai-transport typecheck
```

Expected: all pass.

- [ ] **Step 3: Build affected packages**

Run:

```bash
pnpm --filter @durable-streams/aisdk-transport build
pnpm --filter @durable-streams/tanstack-ai-transport build
```

Expected: clean builds.

- [ ] **Step 4: Smoke test against a real server (optional but recommended)**

If a local Caddy server or dev server is available:

1. Start the dev server: `pnpm --filter @durable-streams/server dev` (or follow repo docs)
2. Write a small ad-hoc script that pipes 100 chunks through `toDurableStreamResponse` (aisdk-transport variant) and measures wall-clock from "source iterator drained" to "response returned" in `mode: "await"`. With the fix, the time after source completion should be ≈1 RTT (one or two POSTs left in the queue), not 100 × RTT.

This step is optional because the unit tests in Tasks 2 and 4 already prove the loop fires concurrently. The smoke test is for sanity against a live HTTP path.

---

## Test Plan Summary

| Layer                        | Test                                                                        | What it proves                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unit (tanstack-ai-transport) | `does not block source iteration on append() resolution`                    | `for await` loop runs ahead of `append()` resolution — all chunks reach `append` before any resolves |
| Unit (tanstack-ai-transport) | `awaits all pending appends before close()`                                 | Pending writes drain before `stream.close()` — no truncation                                         |
| Unit (tanstack-ai-transport) | `surfaces append errors from the latest pending promise`                    | Append failures still propagate to the caller after the fire-and-track refactor                      |
| Unit (tanstack-ai-transport) | `pipeSanitizedChunksToStream does not block on append()`                    | Same property for the chat-session pipe helper                                                       |
| Unit (tanstack-ai-transport) | `appendSanitizedChunksToStream fires all appends without per-item blocking` | Same property for the bounded-array helper                                                           |
| Unit (aisdk-transport)       | `does not block source iteration on append() resolution`                    | Same as above for the AI SDK transport                                                               |
| Unit (aisdk-transport)       | `awaits pending appends before close()`                                     | Same as above                                                                                        |
| Unit (aisdk-transport)       | `surfaces append errors`                                                    | Same as above                                                                                        |
| Existing                     | `tanstack durable session transport` suite                                  | Regression check on the existing tanstack chat session path                                          |
| Existing                     | `pnpm test:run` (client, server, state, etc.)                               | Nothing else broken                                                                                  |

**Why not conformance tests?** CLAUDE.md asks us to prefer conformance tests, but this bug lives in TypeScript-only transport adapters (aisdk-transport, tanstack-ai-transport), not in the protocol or any client SDK. The conformance suite is language-agnostic protocol verification — adding "did the transport adapter coalesce appends?" there would test something only one language has. The protocol behaviour (idempotent batched POSTs) is already covered by existing conformance tests. Unit tests in each transport package are the right layer.

**Manual / out-of-scope:**

- A `lingerMs` option on `append()` (issue #355 option 2) — deferred. The fire-and-track approach in the transports gets the win without the timer-based debounce. Worth a follow-up issue if anyone wants the same fix automatically for user code that still awaits each append.
- Stream-DB docs at `docs/stream-db.md` — left untouched. StateDB is a different consumer with different semantics (one append per logical mutation, not a tight loop of tokens), so the awaited pattern is fine there.

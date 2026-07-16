/**
 * StreamObject — one Durable Object instance per stream.
 *
 * All Durable Streams protocol semantics live here, backed by DO SQLite.
 * The protocol flow is ported from the Durable Streams reference server
 * (packages/server/src/server.ts + store.ts, Apache-2.0, Durable Stream
 * contributors), rewritten against Workers Request/Response with typed
 * outcome values instead of string-matched errors.
 *
 * Concurrency model: the DO input gate serializes storage-touching events
 * and the SQLite API is synchronous, so every validate-then-write block
 * below runs atomically (bodies are always read BEFORE any state is
 * examined). The output gate confirms SQLite writes before responses
 * escape (durability before ack). This replaces the reference server's
 * per-producer promise locks.
 */
import { DurableObject } from "cloudflare:workers"
import {
  CURSOR_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  PRODUCER_EPOCH_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
  PRODUCER_SEQ_HEADER,
  SSE_CLOSED_FIELD,
  SSE_CURSOR_FIELD,
  SSE_OFFSET_FIELD,
  SSE_UP_TO_DATE_FIELD,
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_SSE_DATA_ENCODING_HEADER,
  STREAM_TTL_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  ZERO_OFFSET,
} from "./constants"
import { generateResponseCursor } from "./cursor"
import {
  JsonAppendError,
  concatBytes,
  formatJsonMessages,
  normalizeContentType,
  processJsonAppend,
} from "./json"
import { validateProducer } from "./producer"
import { SqliteStore } from "./store"
import type { ProducerValidationResult } from "./producer"
import type { ClosedBy, ReadBatch, StoredMessage, StreamMeta } from "./store"

/**
 * How long a long-poll (or SSE keep-alive interval) waits for new data.
 * Must be comfortably under the conformance suite's 5s per-test budget
 * while longer than the ~500ms its delivery tests need (see NOTES.md).
 */
const LONG_POLL_TIMEOUT_MS = 2000

/**
 * Maximum accepted request body. DO SQLite caps a single value at 2MB;
 * larger bodies get the protocol's 413 (the conformance suite accepts
 * 413 for its 10MB payload test).
 */
const MAX_BODY_BYTES = 1_900_000

/** Offset params must be a sentinel or our `digits_digits` format. */
const VALID_OFFSET_PATTERN = /^(-1|now|\d+_\d+)$/

/** Strict TTL: non-negative decimal integer, no leading zeros/sign/float. */
const TTL_PATTERN = /^(0|[1-9]\d*)$/

/**
 * Upper bound on Stream-TTL (100 years in seconds). Anything larger risks
 * losing integer precision in `lastAccessedAt + ttl*1000` and produces
 * nonsense alarm times.
 */
const MAX_TTL_SECONDS = 3_153_600_000

/**
 * Per-response read budget. Bounds the memory of catch-up reads and the
 * structured-clone size of fork readRange RPCs; larger streams are served
 * as partial chunks (Stream-Up-To-Date omitted) per protocol §5.6.
 */
export const MAX_READ_BATCH_BYTES: number = 4 * 1024 * 1024

/**
 * Recycle SSE connections after ~60s (protocol §5.8/§10.2 SHOULD) so CDNs
 * can collapse and the DO is not pinned forever by one client.
 */
const MAX_SSE_LIFETIME_MS = 60_000

const STRICT_INTEGER_REGEX = /^\d+$/

/** Minimal shape check for a usable content-type value. */
const CONTENT_TYPE_SHAPE = /^[\w-]+\/[\w-]+/

/** Fork offsets must match our concrete offset format. */
const VALID_FORK_OFFSET_PATTERN = /^\d+_\d+$/

/** Sub-offset: non-negative decimal integer without leading zeros. */
const SUB_OFFSET_PATTERN = /^(0|[1-9]\d*)$/

/** Inclusive upper bound beyond any real offset (for uncapped range reads). */
const MAX_OFFSET_CAP = `9999999999999999_9999999999999999`

const STREAM_FORKED_FROM_HEADER = `Stream-Forked-From`
const STREAM_FORK_OFFSET_HEADER = `Stream-Fork-Offset`
const STREAM_FORK_SUB_OFFSET_HEADER = `Stream-Fork-Sub-Offset`

interface RequestedCreateConfig {
  contentType: string | undefined
  ttlSeconds: number | undefined
  expiresAt: string | undefined
  createClosed: boolean
  forkedFrom: string | undefined
  forkOffsetHeader: string | undefined
  forkSubOffset: number | undefined
}

export type ForkAcquireResult =
  | {
      ok: false
      error:
        | `not_found`
        | `soft_deleted`
        | `content_type_mismatch`
        | `invalid_offset`
    }
  | {
      ok: true
      forkOffset: string
      contentType: string | undefined
      ttlSeconds: number | undefined
      expiresAt: string | undefined
      /** Source generation the edge was acquired under (release qualifier). */
      sourceGeneration: string
    }

/**
 * Encode a payload for SSE. Each line gets its own `data:` prefix; CR,
 * LF, and CRLF all split lines so payloads cannot inject fake SSE events.
 * No space after `data:` — clients strip exactly one leading space.
 */
function encodeSseData(payload: string): string {
  const lines = payload.split(/\r\n|\r|\n/)
  return lines.map((line) => `data:${line}`).join(`\n`) + `\n\n`
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = ``
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function base64FromString(s: string): string {
  return base64FromBytes(new TextEncoder().encode(s))
}

/**
 * workerd rejects pending writes with errors like "Network connection
 * lost." or "This WritableStream has been closed." when the SSE client
 * goes away — routine disconnects (tab closed, navigation), not failures.
 */
function isClientDisconnect(err: unknown): boolean {
  return (
    err instanceof Error &&
    /network connection lost|stream.*(closed|canceled|cancelled|aborted)/i.test(
      err.message
    )
  )
}

interface WaitResult {
  messages: Array<StoredMessage>
  timedOut: boolean
  streamClosed: boolean
  /** True when the returned batch was byte-capped — more data remains. */
  capped: boolean
}

interface PendingWaiter {
  offset: string
  resolve: (batch: ReadBatch) => void
}

interface ProducerHeaders {
  producerId: string
  epoch: number
  seq: number
}

/**
 * Environment the StreamObject requires from the hosting Worker.
 *
 * The binding MUST be named `STREAMS`: fork semantics do DO-to-DO RPC
 * through `this.env.STREAMS`, so the name is fixed by this class, not
 * by the router.
 */
export interface StreamsEnv {
  STREAMS: DurableObjectNamespace<StreamObject>
}

type StreamObjectTestHooks = {
  afterForkAcquire?: () => Promise<void>
  afterInheritedRead?: () => Promise<void>
}

const testHooks = new WeakMap<object, StreamObjectTestHooks>()

/** Test-only fault/barrier installation; not exported from the package entry. */
export function setStreamObjectTestHooks(
  object: StreamObject,
  hooks: StreamObjectTestHooks
): void {
  testHooks.set(object, hooks)
}

export function suspendNextInheritedReadForTest(object: StreamObject): {
  entered: () => boolean
  resume: () => void
} {
  let didEnter = false
  let resume!: () => void
  testHooks.set(object, {
    afterInheritedRead: async () => {
      didEnter = true
      await new Promise<void>((resolve) => (resume = resolve))
    },
  })
  return { entered: () => didEnter, resume: () => resume() }
}

export class StreamObject extends DurableObject<StreamsEnv> {
  private readonly store: SqliteStore
  private waiters: Array<PendingWaiter> = []
  /** Serializes createFork runs (see handlePut); always settles, never rejects. */
  private forkCreateLock: Promise<void> = Promise.resolve()

  private withForkCreateLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.forkCreateLock.then(fn)
    // The lock itself must never reject, or it would poison later runs.
    this.forkCreateLock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  constructor(ctx: DurableObjectState, env: StreamsEnv) {
    super(ctx, env)
    this.store = new SqliteStore(ctx.storage.sql)
    this.store.ensureSchema()
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    switch (request.method) {
      case `PUT`:
        return this.handlePut(request, url, path)
      case `HEAD`:
        return this.handleHead()
      case `GET`:
        return this.handleGet(request, url)
      case `POST`:
        return this.handlePost(request)
      case `DELETE`:
        return this.handleDelete(path)
      default:
        // Drain any body so the response never races the request stream.
        await this.drainBody(request.body)
        return this.text(405, `Method not allowed`)
    }
  }

  override async alarm(): Promise<void> {
    // The armed alarm was just consumed: clear the arming cache so any
    // remaining duty is rearmed rather than suppressed as "unchanged".
    this.lastArmedAlarm = undefined
    // Under the fork create lock: reconciling an intent whose createFork
    // is still in flight would queue a compensating release for the edge
    // that create is about to own.
    await this.withForkCreateLock(() => this.processForkIntents())
    await this.processGcReleases()
    const meta = this.store.getMetaRaw()
    if (!meta) return
    if (this.store.isExpired(meta, Date.now())) {
      if (this.store.forkEdgeCount() > 0) {
        // Expired but referenced by forks: soft-delete instead of purging.
        if (!meta.softDeleted) this.store.setSoftDeleted()
      } else {
        await this.purgeStream(meta)
      }
    } else {
      await this.syncExpiryAlarm()
    }
  }

  // ==========================================================================
  // Fork RPC (called by other StreamObject instances via their stubs)
  // ==========================================================================

  /**
   * Validate this stream as a fork source and take a reference on it,
   * recorded as a fork-edge row keyed by the caller's stable `edgeId`.
   * Insert-if-absent makes retries safe: an acquire whose response was
   * lost and is retried with the same edge id counts exactly once. Runs
   * entirely inside this DO, so the content-type check and the edge
   * insert cannot race (a mismatch must not leak a reference).
   */
  async forkAcquire(options: {
    edgeId: string
    forkOffset: string | undefined
    contentTypeProvided: string | undefined
  }): Promise<ForkAcquireResult> {
    if (options.edgeId === ``) {
      // An empty PRIMARY KEY would silently become a shared edge identity.
      throw new Error(`forkAcquire requires a non-empty edgeId`)
    }
    // Retry of an acquire that already committed: the edge row is the
    // reference, so return the recorded outcome without revalidating —
    // the content-type check is deliberately skipped, and reading current
    // meta is sound because purge() clears fork_edges, so an existing
    // edge implies the meta is still the generation it was acquired under.
    const existingEdge = this.store.getForkEdge(options.edgeId)
    if (existingEdge !== undefined) {
      const rawMeta = this.store.getMetaRaw()
      if (rawMeta !== undefined) {
        return {
          ok: true,
          forkOffset: existingEdge.forkOffset,
          contentType: rawMeta.contentType,
          ttlSeconds: rawMeta.ttlSeconds,
          expiresAt: rawMeta.expiresAt,
          sourceGeneration: rawMeta.generation,
        }
      }
    }

    const meta = await this.getMeta(Date.now())
    if (!meta) {
      return { ok: false, error: `not_found` }
    }
    if (meta.softDeleted) {
      return { ok: false, error: `soft_deleted` }
    }
    if (
      options.contentTypeProvided !== undefined &&
      options.contentTypeProvided.trim() !== `` &&
      normalizeContentType(options.contentTypeProvided) !==
        normalizeContentType(meta.contentType)
    ) {
      return { ok: false, error: `content_type_mismatch` }
    }

    const forkOffset = options.forkOffset ?? meta.currentOffset
    if (forkOffset < ZERO_OFFSET || meta.currentOffset < forkOffset) {
      return { ok: false, error: `invalid_offset` }
    }

    const recordedOffset = this.store.insertForkEdge(options.edgeId, forkOffset)
    return {
      ok: true,
      forkOffset: recordedOffset,
      contentType: meta.contentType,
      ttlSeconds: meta.ttlSeconds,
      expiresAt: meta.expiresAt,
      sourceGeneration: meta.generation,
    }
  }

  /**
   * Release a fork's reference (delete-if-present, so retries of a
   * release whose response was lost are no-ops). A release qualified
   * with a source generation is ignored by any other generation: a
   * delayed release for a purged-and-recreated stream at the same path
   * must not consume a live fork's reference. When the last reference to
   * a soft-deleted stream drops, the stream is purged and the release
   * cascades up the fork chain.
   */
  async forkRelease(options: {
    edgeId: string
    sourceGeneration: string | undefined
  }): Promise<void> {
    if (options.edgeId === ``) {
      throw new Error(`forkRelease requires a non-empty edgeId`)
    }
    const meta = this.store.getMetaRaw()
    if (!meta) return
    if (
      options.sourceGeneration !== undefined &&
      options.sourceGeneration !== meta.generation
    ) {
      return
    }
    if (this.store.getForkEdge(options.edgeId) === undefined) return
    this.store.deleteForkEdge(options.edgeId)
    if (this.store.forkEdgeCount() === 0 && meta.softDeleted) {
      await this.purgeStream(meta)
    }
  }

  /**
   * Read messages in (afterOffset, capOffset], stitching through the fork
   * chain. Reads raw state deliberately: forks must read through
   * soft-deleted (and expired-with-refs) sources. Byte-budgeted so a fork
   * read never moves more than one bounded batch per RPC.
   */
  async readRange(
    afterOffset: string | undefined,
    capOffset: string,
    limit?: number,
    byteBudget?: number
  ): Promise<ReadBatch> {
    const meta = this.store.getMetaRaw()
    if (!meta) return { messages: [], capped: false }
    return this.readStitched(meta, afterOffset, capOffset, limit, byteBudget)
  }

  // ==========================================================================
  // PUT — create stream (idempotent)
  // ==========================================================================

  private async handlePut(
    request: Request,
    url: URL,
    path: string
  ): Promise<Response> {
    // Read the body before ANY validation: responding while the client is
    // still streaming the request body makes workerd throw ("Can't read
    // from request stream after response has been sent"), resetting the DO.
    const body = await this.readBody(request)
    if (body === `too_large`) {
      return this.text(413, `Payload too large`)
    }

    let contentType = request.headers.get(`content-type`) ?? undefined

    const forkedFrom =
      request.headers.get(STREAM_FORKED_FROM_HEADER) ?? undefined
    const forkOffsetHeader =
      request.headers.get(STREAM_FORK_OFFSET_HEADER) ?? undefined
    const forkSubOffsetHeader =
      request.headers.get(STREAM_FORK_SUB_OFFSET_HEADER) ?? undefined

    // Sanitize content-type: empty/invalid falls back to the default —
    // except for forks, where an omitted Content-Type means "inherit".
    if (
      contentType === undefined ||
      contentType.trim() === `` ||
      !CONTENT_TYPE_SHAPE.test(contentType)
    ) {
      contentType =
        forkedFrom !== undefined ? undefined : `application/octet-stream`
    }

    const ttlHeader = request.headers.get(STREAM_TTL_HEADER) ?? undefined
    const expiresAtHeader =
      request.headers.get(STREAM_EXPIRES_AT_HEADER) ?? undefined
    const createClosed =
      (request.headers.get(STREAM_CLOSED_HEADER) ?? ``).toLowerCase() === `true`

    if (ttlHeader !== undefined && expiresAtHeader !== undefined) {
      return this.text(
        400,
        `Cannot specify both Stream-TTL and Stream-Expires-At`
      )
    }

    let ttlSeconds: number | undefined
    if (ttlHeader !== undefined) {
      if (!TTL_PATTERN.test(ttlHeader)) {
        return this.text(400, `Invalid Stream-TTL value`)
      }
      ttlSeconds = parseInt(ttlHeader, 10)
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds > MAX_TTL_SECONDS) {
        return this.text(400, `Invalid Stream-TTL value`)
      }
    }

    if (expiresAtHeader !== undefined) {
      const timestamp = new Date(expiresAtHeader)
      if (Number.isNaN(timestamp.getTime())) {
        return this.text(400, `Invalid Stream-Expires-At timestamp`)
      }
    }

    if (
      forkOffsetHeader !== undefined &&
      !VALID_FORK_OFFSET_PATTERN.test(forkOffsetHeader)
    ) {
      return this.text(400, `Invalid Stream-Fork-Offset format`)
    }

    let forkSubOffset: number | undefined
    if (forkSubOffsetHeader !== undefined) {
      if (forkedFrom === undefined) {
        return this.text(
          400,
          `Stream-Fork-Sub-Offset requires Stream-Forked-From`
        )
      }
      if (!SUB_OFFSET_PATTERN.test(forkSubOffsetHeader)) {
        return this.text(400, `Invalid Stream-Fork-Sub-Offset format`)
      }
      forkSubOffset = parseInt(forkSubOffsetHeader, 10)
    }

    const now = Date.now()
    const requested: RequestedCreateConfig = {
      contentType,
      ttlSeconds,
      expiresAt: expiresAtHeader,
      createClosed,
      forkedFrom,
      forkOffsetHeader,
      forkSubOffset,
    }

    // getMeta can await (expiry purge cascades a cross-DO forkRelease),
    // which opens the input gate — so a concurrent PUT may have created
    // the stream even when getMeta returned undefined. Re-read raw state
    // to make PUT idempotent instead of crashing on a duplicate INSERT.
    const existing = (await this.getMeta(now)) ?? this.store.getMetaRaw()

    if (existing) {
      return this.existingStreamResponse(existing, requested)
    }

    if (forkedFrom !== undefined) {
      // Serialize fork creations: createFork awaits RPCs mid-flow (which
      // opens the input gate), and two interleaved creations for the same
      // path would share the durable edge intent — the loser's release
      // would then destroy the winner's reference on the source.
      return this.withForkCreateLock(() =>
        this.createFork(url, path, {
          forkedFrom,
          forkOffsetHeader,
          forkSubOffset,
          contentType,
          ttlSeconds,
          expiresAt: expiresAtHeader,
          createClosed,
          body,
          now,
        })
      )
    }

    // Process initial data BEFORE creating meta so an invalid JSON body
    // leaves no stream behind.
    const resolvedContentType = contentType ?? `application/octet-stream`
    let initialPayload: Uint8Array | undefined
    if (body.length > 0) {
      if (normalizeContentType(resolvedContentType) === `application/json`) {
        try {
          initialPayload = processJsonAppend(body, true)
        } catch (err) {
          if (err instanceof JsonAppendError) {
            return this.text(400, err.message)
          }
          throw err
        }
        if (initialPayload.length > MAX_BODY_BYTES) {
          return this.text(413, `Payload too large`)
        }
      } else {
        initialPayload = body
      }
    }

    this.store.createMeta({
      contentType: resolvedContentType,
      ttlSeconds,
      expiresAt: expiresAtHeader,
      closed: createClosed,
      now,
    })

    let currentOffset = this.store.getMetaRaw()?.currentOffset ?? ``
    if (initialPayload !== undefined && initialPayload.length > 0) {
      currentOffset = this.store.appendMessage(
        currentOffset,
        initialPayload,
        now
      )
    }

    await this.syncExpiryAlarm()

    const headers: Record<string, string> = {
      "content-type": resolvedContentType,
      [STREAM_OFFSET_HEADER]: currentOffset,
      location: `${url.origin}${path}`,
    }
    if (createClosed) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }
    return this.respond(201, headers)
  }

  /**
   * Respond to a PUT on an already-existing stream: 200 when the
   * requested config matches (idempotent), 409 otherwise.
   */
  private existingStreamResponse(
    existing: StreamMeta,
    req: RequestedCreateConfig
  ): Response {
    if (existing.softDeleted) {
      return this.text(
        409,
        `stream was deleted but still has active forks — path cannot be reused until all forks are removed`
      )
    }
    // A fork re-PUT that omits Content-Type means "inherit from source",
    // which matches whatever the fork inherited — skip the comparison.
    const contentTypeMatches =
      req.contentType === undefined &&
      req.forkedFrom !== undefined &&
      req.forkedFrom === existing.forkedFrom
        ? true
        : (normalizeContentType(req.contentType) ||
            `application/octet-stream`) ===
          (normalizeContentType(existing.contentType) ||
            `application/octet-stream`)
    const ttlMatches = req.ttlSeconds === existing.ttlSeconds
    const expiresMatches = req.expiresAt === existing.expiresAt
    const closedMatches = req.createClosed === existing.closed
    const forkedFromMatches = req.forkedFrom === existing.forkedFrom
    // forkOffset only compared when explicitly supplied: an omitted
    // offset was resolved server-side at creation, so a second PUT
    // that also omits it stays idempotent.
    const forkOffsetMatches =
      req.forkOffsetHeader === undefined ||
      req.forkOffsetHeader === existing.forkOffset
    const forkSubOffsetMatches =
      (req.forkSubOffset ?? 0) === (existing.forkSubOffset ?? 0)

    if (
      contentTypeMatches &&
      ttlMatches &&
      expiresMatches &&
      closedMatches &&
      forkedFromMatches &&
      forkOffsetMatches &&
      forkSubOffsetMatches
    ) {
      // Idempotent success — the body is ignored for existing streams.
      const headers: Record<string, string> = {
        "content-type":
          existing.contentType ?? req.contentType ?? `application/octet-stream`,
        [STREAM_OFFSET_HEADER]: existing.currentOffset,
      }
      if (existing.closed) {
        headers[STREAM_CLOSED_HEADER] = `true`
      }
      return this.respond(200, headers)
    }
    return this.text(409, `Stream already exists with different configuration`)
  }

  /** Create this stream as a fork of another stream. */
  private async createFork(
    url: URL,
    path: string,
    options: {
      forkedFrom: string
      forkOffsetHeader: string | undefined
      forkSubOffset: number | undefined
      contentType: string | undefined
      ttlSeconds: number | undefined
      expiresAt: string | undefined
      createClosed: boolean
      body: Uint8Array
      now: number
    }
  ): Promise<Response> {
    const { forkedFrom, now } = options

    // A stream cannot fork from itself (calling our own stub would
    // deadlock); the reference server reports this as source-not-found.
    if (forkedFrom === path) {
      return this.text(404, `Source stream not found`)
    }

    const sourceStub = this.env.STREAMS.get(
      this.env.STREAMS.idFromName(forkedFrom)
    )

    // Give the edge a stable identity, persisted BEFORE the acquire RPC:
    // if the acquire commits on the source but our response is lost, the
    // create retry finds the intent and re-acquires with the SAME edge id
    // instead of taking (and leaking) a second reference.
    const paramsKey = JSON.stringify([
      forkedFrom,
      options.forkOffsetHeader ?? null,
    ])
    let edgeId = this.store.getForkIntent(paramsKey)
    if (edgeId === undefined) {
      edgeId = crypto.randomUUID()
      this.store.putForkIntent(edgeId, forkedFrom, paramsKey)
      // If the acquire commits but this object is interrupted before it can
      // create meta, the alarm turns the intent into a compensating release.
      await this.armAlarmAt(Date.now() + 5_000)
    }

    const acquired = await sourceStub.forkAcquire({
      edgeId,
      forkOffset: options.forkOffsetHeader,
      contentTypeProvided: options.contentType,
    })
    await testHooks.get(this)?.afterForkAcquire?.()

    if (!acquired.ok) {
      // Validation failed, so no reference was taken for this edge id.
      this.store.deleteForkIntent(edgeId)
      switch (acquired.error) {
        case `not_found`:
          return this.text(404, `Source stream not found`)
        case `soft_deleted`:
          return this.text(
            409,
            `source stream was deleted but still has active forks`
          )
        case `content_type_mismatch`:
          return this.text(409, `Content type mismatch with source stream`)
        case `invalid_offset`:
          return this.text(400, `Fork offset beyond source stream length`)
      }
    }

    const release = async (): Promise<void> => {
      // Queue the release durably BEFORE the RPC (and drop the intent in
      // the same commit): if this isolate dies mid-release, the queued
      // duty survives and the alarm retries it — otherwise the acquired
      // edge would pin the source with no recovery record anywhere.
      this.store.enqueueGcRelease(edgeId, forkedFrom, acquired.sourceGeneration)
      this.store.deleteForkIntent(edgeId)
      await this.flushGcReleases()
    }

    const resolvedContentType =
      options.contentType !== undefined && options.contentType.trim() !== ``
        ? options.contentType
        : acquired.contentType
    const isJson =
      normalizeContentType(resolvedContentType) === `application/json`

    // Fork expiry: an explicit TTL or Expires-At wins; otherwise inherit
    // from the source (TTL preferred), giving forks independent lifetimes.
    let effectiveTtl = options.ttlSeconds
    let effectiveExpiresAt = options.expiresAt
    if (effectiveTtl === undefined && effectiveExpiresAt === undefined) {
      if (acquired.ttlSeconds !== undefined) {
        effectiveTtl = acquired.ttlSeconds
      } else if (acquired.expiresAt !== undefined) {
        effectiveExpiresAt = acquired.expiresAt
      }
    }

    // Resolve the sub-offset prefix (a synthetic first message holding the
    // leading slice of the source message at the fork point).
    let subOffsetPrefix: Uint8Array | undefined
    if (options.forkSubOffset !== undefined && options.forkSubOffset > 0) {
      const past = await sourceStub.readRange(
        acquired.forkOffset,
        MAX_OFFSET_CAP,
        1
      )
      const first = past.messages[0]
      if (!first) {
        await release()
        return this.text(400, `Invalid fork sub-offset`)
      }
      if (isJson) {
        const text = new TextDecoder().decode(first.data)
        const trimmed = text.endsWith(`,`) ? text.slice(0, -1) : text
        let values: Array<unknown>
        try {
          const parsed: unknown = JSON.parse(`[${trimmed}]`)
          if (!Array.isArray(parsed)) {
            throw new JsonAppendError(`Invalid fork sub-offset`)
          }
          values = parsed
        } catch {
          await release()
          return this.text(400, `Invalid fork sub-offset`)
        }
        if (options.forkSubOffset > values.length) {
          await release()
          return this.text(400, `Invalid fork sub-offset`)
        }
        const prefix = values
          .slice(0, options.forkSubOffset)
          .map((v) => JSON.stringify(v))
        subOffsetPrefix = new TextEncoder().encode(prefix.join(`,`) + `,`)
      } else {
        if (options.forkSubOffset > first.data.length) {
          await release()
          return this.text(400, `Invalid fork sub-offset`)
        }
        subOffsetPrefix = first.data.slice(0, options.forkSubOffset)
      }
    }

    // Process initial body data before creating anything.
    let initialPayload: Uint8Array | undefined
    if (options.body.length > 0) {
      if (isJson) {
        try {
          initialPayload = processJsonAppend(options.body, true)
        } catch (err) {
          if (err instanceof JsonAppendError) {
            await release()
            return this.text(400, err.message)
          }
          throw err
        }
        if (initialPayload.length > MAX_BODY_BYTES) {
          await release()
          return this.text(413, `Payload too large`)
        }
      } else {
        initialPayload = options.body
      }
    }

    // The forkAcquire / readRange RPCs above opened the input gate: a
    // concurrent PUT may have created this path in the meantime. Creating
    // again would violate the meta PK, so release our reference and fall
    // back to the idempotency comparison. Defense in depth (the fork
    // create lock should prevent this interleaving): if the existing
    // stream owns this very edge, releasing it would destroy the
    // surviving fork's reference — drop only the intent.
    const raced = this.store.getMetaRaw()
    if (raced) {
      if (raced.forkEdgeId === edgeId) {
        this.store.deleteForkIntent(edgeId)
      } else {
        await release()
      }
      return this.existingStreamResponse(raced, {
        contentType: options.contentType,
        ttlSeconds: options.ttlSeconds,
        expiresAt: options.expiresAt,
        createClosed: options.createClosed,
        forkedFrom,
        forkOffsetHeader: options.forkOffsetHeader,
        forkSubOffset: options.forkSubOffset,
      })
    }

    let currentOffset: string
    try {
      this.store.createMeta({
        contentType: resolvedContentType,
        ttlSeconds: effectiveTtl,
        expiresAt: effectiveExpiresAt,
        closed: options.createClosed,
        now,
        forkedFrom,
        forkOffset: acquired.forkOffset,
        forkSubOffset:
          options.forkSubOffset !== undefined && options.forkSubOffset > 0
            ? options.forkSubOffset
            : undefined,
        forkEdgeId: edgeId,
        forkSourceGen: acquired.sourceGeneration,
      })

      currentOffset = acquired.forkOffset
      if (subOffsetPrefix !== undefined && subOffsetPrefix.length > 0) {
        currentOffset = this.store.appendMessage(
          currentOffset,
          subOffsetPrefix,
          now
        )
      }
      if (initialPayload !== undefined && initialPayload.length > 0) {
        currentOffset = this.store.appendMessage(
          currentOffset,
          initialPayload,
          now
        )
      }
    } catch (err) {
      // Never leak the acquired source reference on a failed create.
      await release()
      throw err
    }

    // The edge is now owned by the created stream's meta row.
    this.store.deleteForkIntent(edgeId)
    await this.syncExpiryAlarm()

    const headers: Record<string, string> = {
      "content-type": resolvedContentType ?? `application/octet-stream`,
      [STREAM_OFFSET_HEADER]: currentOffset,
      location: `${url.origin}${path}`,
    }
    if (options.createClosed) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }
    return this.respond(201, headers)
  }

  // ==========================================================================
  // HEAD — metadata only; must NOT reset the sliding TTL
  // ==========================================================================

  private async handleHead(): Promise<Response> {
    const meta = await this.getMeta(Date.now())
    if (!meta) {
      return this.respond(404, { "content-type": `text/plain` })
    }
    if (meta.softDeleted) {
      return this.respond(410, { "content-type": `text/plain` })
    }

    const headers: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: meta.currentOffset,
      "cache-control": `no-store`,
    }
    if (meta.contentType !== undefined) {
      headers[`content-type`] = meta.contentType
    }
    if (meta.closed) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }
    if (meta.ttlSeconds !== undefined) {
      headers[STREAM_TTL_HEADER] = String(meta.ttlSeconds)
    }
    if (meta.expiresAt !== undefined) {
      headers[STREAM_EXPIRES_AT_HEADER] = meta.expiresAt
    }
    headers[`etag`] = this.makeEtag(`-1`, meta.currentOffset, meta.closed)

    return this.respond(200, headers)
  }

  // ==========================================================================
  // GET — catch-up reads, long-poll, SSE
  // ==========================================================================

  private async handleGet(request: Request, url: URL): Promise<Response> {
    const now = Date.now()
    const meta = await this.getMeta(now)
    if (!meta) {
      return this.text(404, `Stream not found`)
    }
    if (meta.softDeleted) {
      return this.text(410, `Stream is gone`)
    }

    const offsetParam = url.searchParams.get(OFFSET_QUERY_PARAM) ?? undefined
    const live = url.searchParams.get(LIVE_QUERY_PARAM)
    const cursor = url.searchParams.get(CURSOR_QUERY_PARAM) ?? undefined

    if (offsetParam !== undefined) {
      if (offsetParam === ``) {
        return this.text(400, `Empty offset parameter`)
      }
      if (url.searchParams.getAll(OFFSET_QUERY_PARAM).length > 1) {
        return this.text(400, `Multiple offset parameters not allowed`)
      }
      if (!VALID_OFFSET_PATTERN.test(offsetParam)) {
        return this.text(400, `Invalid offset format`)
      }
    }

    if ((live === `long-poll` || live === `sse`) && offsetParam === undefined) {
      return this.text(
        400,
        `${live === `sse` ? `SSE` : `Long-poll`} requires offset parameter`
      )
    }

    if (live === `sse`) {
      const ct = normalizeContentType(meta.contentType)
      const isTextCompatible =
        ct.startsWith(`text/`) || ct === `application/json`
      const useBase64 = !isTextCompatible
      const sseOffset =
        offsetParam === `now` ? meta.currentOffset : (offsetParam ?? `-1`)
      return this.handleSse(meta, sseOffset, cursor, useBase64)
    }

    // Catch-up read at the tail: empty response, never cached.
    if (offsetParam === `now` && live !== `long-poll`) {
      // Still a read: refresh the sliding TTL like any other GET.
      this.store.touchAccess(now)
      await this.syncExpiryAlarm()
      const headers: Record<string, string> = {
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
        [STREAM_UP_TO_DATE_HEADER]: `true`,
        "cache-control": `no-store`,
      }
      if (meta.contentType !== undefined) {
        headers[`content-type`] = meta.contentType
      }
      if (meta.closed) {
        headers[STREAM_CLOSED_HEADER] = `true`
      }
      const isJsonMode =
        normalizeContentType(meta.contentType) === `application/json`
      return this.respond(200, headers, isJsonMode ? `[]` : ``)
    }

    const effectiveOffset =
      offsetParam === `now` ? meta.currentOffset : offsetParam

    const initialBatch = await this.readStream(meta, effectiveOffset)
    let messages = initialBatch.messages
    // Partial (byte-capped) responses omit Stream-Up-To-Date per §5.6.
    let upToDate = !initialBatch.capped
    this.store.touchAccess(now)
    await this.syncExpiryAlarm()

    const clientIsCaughtUp =
      (effectiveOffset !== undefined &&
        effectiveOffset === meta.currentOffset) ||
      offsetParam === `now`
    if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
      if (meta.closed) {
        // Closed and at tail: EOF immediately, no waiting.
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: meta.currentOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CLOSED_HEADER]: `true`,
        })
      }

      const waitOffset = effectiveOffset ?? meta.currentOffset
      const result = await this.waitForMessages(
        waitOffset,
        LONG_POLL_TIMEOUT_MS
      )
      this.store.touchAccess(Date.now())
      await this.syncExpiryAlarm()

      if (result.streamClosed && result.messages.length === 0) {
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: waitOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CURSOR_HEADER]: generateResponseCursor(cursor),
          [STREAM_CLOSED_HEADER]: `true`,
        })
      }

      if (result.timedOut) {
        const headers: Record<string, string> = {
          [STREAM_OFFSET_HEADER]: waitOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CURSOR_HEADER]: generateResponseCursor(cursor),
        }
        if (this.store.getMetaRaw()?.closed === true) {
          headers[STREAM_CLOSED_HEADER] = `true`
        }
        return this.respond(204, headers)
      }

      messages = result.messages
      upToDate = !result.capped
    }

    // Build the response. Re-read meta: it may have changed during a wait.
    const freshMeta = this.store.getMetaRaw() ?? meta
    const headers: Record<string, string> = {}
    if (freshMeta.contentType !== undefined) {
      headers[`content-type`] = freshMeta.contentType
    }

    const lastMessage = messages[messages.length - 1]
    const responseOffset = lastMessage?.offset ?? freshMeta.currentOffset
    headers[STREAM_OFFSET_HEADER] = responseOffset

    if (live === `long-poll`) {
      headers[STREAM_CURSOR_HEADER] = generateResponseCursor(cursor)
    }
    if (upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = `true`
    }

    const clientAtTail = responseOffset === freshMeta.currentOffset
    const closedSuffix = freshMeta.closed && clientAtTail && upToDate
    if (closedSuffix) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }

    const startOffset = offsetParam ?? `-1`
    const etag = this.makeEtag(startOffset, responseOffset, closedSuffix)
    headers[`etag`] = etag

    const ifNoneMatch = request.headers.get(`if-none-match`)
    if (ifNoneMatch !== null && ifNoneMatch === etag) {
      return this.respond(304, { etag })
    }

    // Recommended shared-cache headers for catch-up reads (§10.1);
    // live-mode responses stay uncached.
    if (live !== `long-poll`) {
      headers[`cache-control`] =
        `public, max-age=60, stale-while-revalidate=300`
    }

    const fragments = messages.map((m) => m.data)
    const body =
      normalizeContentType(freshMeta.contentType) === `application/json`
        ? formatJsonMessages(fragments)
        : concatBytes(fragments)

    return this.respond(200, headers, body)
  }

  // ==========================================================================
  // SSE
  // ==========================================================================

  private handleSse(
    meta: StreamMeta,
    initialOffset: string,
    cursor: string | undefined,
    useBase64: boolean
  ): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const isJson = normalizeContentType(meta.contentType) === `application/json`

    // Pump in the background; the pending stream keeps the DO alive.
    // Write failures mean the client disconnected — expected; anything
    // else is logged so real storage/RPC failures stay observable.
    void this.pumpSse(
      meta.generation,
      initialOffset,
      cursor,
      useBase64,
      isJson,
      writer
    )
      .catch((err: unknown) => {
        if (!isClientDisconnect(err)) {
          console.warn(`SSE pump ended with error`, err)
        }
      })
      .finally(() => writer.close().catch(() => undefined))

    const headers: Record<string, string> = {
      "content-type": `text/event-stream`,
      "cache-control": `no-cache`,
      connection: `keep-alive`,
      // Prevent edge compression from buffering SSE events: compressed
      // responses are flushed in compressor-sized blocks, which delays
      // (and can split) events for live clients.
      "content-encoding": `identity`,
    }
    if (useBase64) {
      headers[STREAM_SSE_DATA_ENCODING_HEADER] = `base64`
    }
    return this.respond(200, headers, readable)
  }

  private async pumpSse(
    generation: string,
    initialOffset: string,
    cursor: string | undefined,
    useBase64: boolean,
    isJson: boolean,
    writer: WritableStreamDefaultWriter<Uint8Array>
  ): Promise<void> {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const write = (s: string): Promise<void> => writer.write(encoder.encode(s))
    const startedAt = Date.now()

    let currentOffset = initialOffset

    for (;;) {
      const loopMeta = this.store.getMetaRaw()
      if (loopMeta?.generation !== generation) {
        // Stream deleted/expired (and possibly recreated) mid-tail: this
        // subscription belongs to the old generation — end it rather than
        // silently rebinding to a different stream.
        return
      }
      const batch = await this.readStream(
        loopMeta,
        currentOffset === `-1` ? undefined : currentOffset
      )

      // The whole batch becomes ONE data event followed by ONE control
      // event (§5.8: a control event follows every data event). Per-message
      // data events sharing a single control would make JSON catch-up
      // unparseable for clients that collect data up to the control
      // boundary (`[a][b]` is not a JSON value). One frame also means one
      // transport chunk, so the suite's SSE reader never stops mid-event.
      let frame = ``
      if (batch.messages.length > 0) {
        const fragments = batch.messages.map((m) => m.data)
        let dataPayload: string
        if (useBase64) {
          dataPayload = base64FromBytes(concatBytes(fragments))
        } else if (isJson) {
          dataPayload = decoder.decode(formatJsonMessages(fragments))
        } else {
          dataPayload = decoder.decode(concatBytes(fragments))
        }
        frame += `event: data\n` + encodeSseData(dataPayload)
      }

      const freshMeta = this.store.getMetaRaw()
      if (freshMeta?.generation !== generation) {
        return
      }
      this.store.touchAccess(Date.now())
      await this.syncExpiryAlarm()

      const lastMessage = batch.messages[batch.messages.length - 1]
      const controlOffset = lastMessage?.offset ?? freshMeta.currentOffset
      const clientAtTail =
        !batch.capped && controlOffset === freshMeta.currentOffset

      const controlData: Record<string, string | boolean> = {
        [SSE_OFFSET_FIELD]: controlOffset,
      }
      if (freshMeta.closed && clientAtTail) {
        // Final control event: streamCursor omitted, upToDate implied.
        controlData[SSE_CLOSED_FIELD] = true
      } else {
        controlData[SSE_CURSOR_FIELD] = generateResponseCursor(cursor)
        if (!batch.capped) {
          controlData[SSE_UP_TO_DATE_FIELD] = true
        }
      }
      frame += `event: control\n` + encodeSseData(JSON.stringify(controlData))
      await write(frame)

      if (freshMeta.closed && clientAtTail) {
        return
      }
      currentOffset = controlOffset

      if (batch.capped) {
        // More catch-up data remains — keep reading without waiting.
        continue
      }

      // Recycle long-lived connections (§5.8 SHOULD, ~60s) at a clean
      // control boundary; the client reconnects from streamNextOffset.
      if (Date.now() - startedAt >= MAX_SSE_LIFETIME_MS) {
        return
      }

      const result = await this.waitForMessages(
        currentOffset,
        LONG_POLL_TIMEOUT_MS
      )
      this.store.touchAccess(Date.now())
      await this.syncExpiryAlarm()

      if (result.streamClosed && result.messages.length === 0) {
        const finalControl: Record<string, string | boolean> = {
          [SSE_OFFSET_FIELD]: currentOffset,
          [SSE_CLOSED_FIELD]: true,
        }
        await write(
          `event: control\n` + encodeSseData(JSON.stringify(finalControl))
        )
        return
      }

      if (result.timedOut) {
        const afterWait = this.store.getMetaRaw()
        if (afterWait?.generation !== generation) return
        if (afterWait.closed) {
          const closedControl: Record<string, string | boolean> = {
            [SSE_OFFSET_FIELD]: currentOffset,
            [SSE_CLOSED_FIELD]: true,
          }
          await write(
            `event: control\n` + encodeSseData(JSON.stringify(closedControl))
          )
          return
        }
        const keepAlive: Record<string, string | boolean> = {
          [SSE_OFFSET_FIELD]: currentOffset,
          [SSE_CURSOR_FIELD]: generateResponseCursor(cursor),
          [SSE_UP_TO_DATE_FIELD]: true,
        }
        await write(
          `event: control\n` + encodeSseData(JSON.stringify(keepAlive))
        )
      }
      // Loop continues: read any new messages.
    }
  }

  // ==========================================================================
  // POST — append / close
  // ==========================================================================

  private async handlePost(request: Request): Promise<Response> {
    // Body first — see handlePut: early responses mid-upload reset the DO.
    const body = await this.readBody(request)
    if (body === `too_large`) {
      return this.text(413, `Payload too large`)
    }

    const contentType = request.headers.get(`content-type`) ?? undefined
    const seq = request.headers.get(STREAM_SEQ_HEADER) ?? undefined
    const closeStream =
      (request.headers.get(STREAM_CLOSED_HEADER) ?? ``).toLowerCase() === `true`

    const producerId = request.headers.get(PRODUCER_ID_HEADER) ?? undefined
    const producerEpochStr =
      request.headers.get(PRODUCER_EPOCH_HEADER) ?? undefined
    const producerSeqStr = request.headers.get(PRODUCER_SEQ_HEADER) ?? undefined

    const hasAnyProducerHeader =
      producerId !== undefined ||
      producerEpochStr !== undefined ||
      producerSeqStr !== undefined
    const hasAllProducerHeaders =
      producerId !== undefined &&
      producerEpochStr !== undefined &&
      producerSeqStr !== undefined

    if (hasAnyProducerHeader && !hasAllProducerHeaders) {
      return this.text(
        400,
        `All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together`
      )
    }
    if (hasAllProducerHeaders && producerId === ``) {
      return this.text(400, `Invalid Producer-Id: must not be empty`)
    }

    let producer: ProducerHeaders | undefined
    if (hasAllProducerHeaders) {
      if (!STRICT_INTEGER_REGEX.test(producerEpochStr)) {
        return this.text(
          400,
          `Invalid Producer-Epoch: must be a non-negative integer`
        )
      }
      const epoch = Number(producerEpochStr)
      if (!Number.isSafeInteger(epoch)) {
        return this.text(
          400,
          `Invalid Producer-Epoch: must be a non-negative integer`
        )
      }
      if (!STRICT_INTEGER_REGEX.test(producerSeqStr)) {
        return this.text(
          400,
          `Invalid Producer-Seq: must be a non-negative integer`
        )
      }
      const seqNum = Number(producerSeqStr)
      if (!Number.isSafeInteger(seqNum)) {
        return this.text(
          400,
          `Invalid Producer-Seq: must be a non-negative integer`
        )
      }
      producer = { producerId, epoch, seq: seqNum }
    }

    const now = Date.now()

    // Close-only request (empty body + Stream-Closed: true). Content-Type
    // validation is skipped per protocol §5.2.
    if (body.length === 0 && closeStream) {
      return this.handleCloseOnly(producer, now)
    }

    if (body.length === 0) {
      return this.text(400, `Empty body`)
    }

    if (contentType === undefined) {
      return this.text(400, `Content-Type header is required`)
    }

    const meta = await this.getMeta(now)
    if (!meta) {
      return this.text(404, `Stream not found`)
    }
    if (meta.softDeleted) {
      return this.text(410, `Stream is gone`)
    }

    // Closed check comes first so clients always see Stream-Closed.
    if (meta.closed) {
      if (
        producer !== undefined &&
        meta.closedBy?.producerId === producer.producerId &&
        meta.closedBy.epoch === producer.epoch &&
        meta.closedBy.seq === producer.seq
      ) {
        // Duplicate of the closing request — idempotent success.
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: meta.currentOffset,
          [STREAM_CLOSED_HEADER]: `true`,
          [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
          [PRODUCER_SEQ_HEADER]: String(producer.seq),
        })
      }
      return this.text(409, `Stream is closed`, {
        [STREAM_CLOSED_HEADER]: `true`,
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
      })
    }

    // Content-type mismatch check (normalized, so charset params match).
    if (meta.contentType !== undefined) {
      if (
        normalizeContentType(contentType) !==
        normalizeContentType(meta.contentType)
      ) {
        return this.text(409, `Content-type mismatch`)
      }
    }

    // Producer validation runs BEFORE the Stream-Seq check so a retry
    // carrying both is deduplicated to 204 instead of a Stream-Seq 409.
    let producerResult: ProducerValidationResult | undefined
    if (producer !== undefined) {
      const state = this.store.getProducerState(producer.producerId, now)
      producerResult = validateProducer(
        state,
        producer.producerId,
        producer.epoch,
        producer.seq,
        now
      )
      if (producerResult.status !== `accepted`) {
        return this.producerFailureResponse(producerResult, producer, false)
      }
    }

    // Stream-Seq writer coordination: byte-wise lexicographic, strictly
    // increasing.
    if (seq !== undefined) {
      if (meta.lastSeq !== undefined && seq <= meta.lastSeq) {
        return this.text(409, `Sequence conflict`)
      }
    }

    // Process the payload (JSON validation) BEFORE committing any state.
    let payload = body
    if (normalizeContentType(meta.contentType) === `application/json`) {
      try {
        payload = processJsonAppend(body, false)
      } catch (err) {
        if (err instanceof JsonAppendError) {
          return this.text(400, err.message)
        }
        throw err
      }
      // JSON normalization can expand the payload (e.g. escaping); the
      // stored fragment must still fit SQLite's per-value cap.
      if (payload.length > MAX_BODY_BYTES) {
        return this.text(413, `Payload too large`)
      }
    }

    const newOffset = this.store.appendMessage(meta.currentOffset, payload, now)

    if (producerResult?.status === `accepted`) {
      this.store.commitProducerState(
        producerResult.producerId,
        producerResult.proposedState
      )
    }
    if (seq !== undefined) {
      this.store.setLastSeq(seq)
    }

    let closedBy: ClosedBy | undefined
    if (closeStream) {
      if (producer !== undefined) {
        closedBy = {
          producerId: producer.producerId,
          epoch: producer.epoch,
          seq: producer.seq,
        }
      }
      this.store.setClosed(closedBy)
    }

    this.store.touchAccess(now)
    await this.syncExpiryAlarm()

    // Data waiters are notified before close waiters so append-and-close
    // delivers the final message before the EOF signal.
    this.notifyAppend()
    if (closeStream) {
      this.notifyClosed()
    }

    const responseHeaders: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: newOffset,
    }
    if (producer !== undefined) {
      responseHeaders[PRODUCER_EPOCH_HEADER] = String(producer.epoch)
      responseHeaders[PRODUCER_SEQ_HEADER] = String(producer.seq)
    }
    if (closeStream) {
      responseHeaders[STREAM_CLOSED_HEADER] = `true`
    }
    // 200 for producer appends (with headers), 204 for plain appends.
    return this.respond(producer !== undefined ? 200 : 204, responseHeaders)
  }

  private async handleCloseOnly(
    producer: ProducerHeaders | undefined,
    now: number
  ): Promise<Response> {
    const meta = await this.getMeta(now)
    if (!meta) {
      return this.text(404, `Stream not found`)
    }
    if (meta.softDeleted) {
      return this.text(410, `Stream is gone`)
    }

    if (producer === undefined) {
      // Simple idempotent close. A close is a write, so it refreshes the
      // sliding TTL like any other successful POST.
      this.store.setClosed(undefined)
      this.store.touchAccess(now)
      await this.syncExpiryAlarm()
      this.notifyClosed()
      return this.respond(204, {
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
        [STREAM_CLOSED_HEADER]: `true`,
      })
    }

    if (meta.closed) {
      if (
        meta.closedBy?.producerId === producer.producerId &&
        meta.closedBy.epoch === producer.epoch &&
        meta.closedBy.seq === producer.seq
      ) {
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: meta.currentOffset,
          [STREAM_CLOSED_HEADER]: `true`,
          [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
          [PRODUCER_SEQ_HEADER]: String(producer.seq),
        })
      }
      // Already closed by a different request — conflict.
      return this.text(409, `Stream is closed`, {
        [STREAM_CLOSED_HEADER]: `true`,
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
      })
    }

    const state = this.store.getProducerState(producer.producerId, now)
    const producerResult = validateProducer(
      state,
      producer.producerId,
      producer.epoch,
      producer.seq,
      now
    )
    if (producerResult.status !== `accepted`) {
      return this.producerFailureResponse(producerResult, producer, true)
    }

    this.store.commitProducerState(
      producerResult.producerId,
      producerResult.proposedState
    )
    this.store.setClosed({
      producerId: producer.producerId,
      epoch: producer.epoch,
      seq: producer.seq,
    })
    this.store.touchAccess(now)
    await this.syncExpiryAlarm()
    this.notifyClosed()

    return this.respond(204, {
      [STREAM_OFFSET_HEADER]: meta.currentOffset,
      [STREAM_CLOSED_HEADER]: `true`,
      [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
      [PRODUCER_SEQ_HEADER]: String(producer.seq),
    })
  }

  /** Map a non-accepted producer validation result to its response. */
  private producerFailureResponse(
    result: Exclude<ProducerValidationResult, { status: `accepted` }>,
    producer: ProducerHeaders,
    isCloseOnly: boolean
  ): Response {
    switch (result.status) {
      case `duplicate`: {
        const headers: Record<string, string> = {
          [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
          [PRODUCER_SEQ_HEADER]: String(result.lastSeq),
        }
        if (isCloseOnly) {
          const meta = this.store.getMetaRaw()
          headers[STREAM_OFFSET_HEADER] = meta?.currentOffset ?? ``
          if (meta?.closed === true) {
            headers[STREAM_CLOSED_HEADER] = `true`
          }
        }
        return this.respond(204, headers)
      }
      case `stale_epoch`:
        return this.text(403, `Stale producer epoch`, {
          [PRODUCER_EPOCH_HEADER]: String(result.currentEpoch),
        })
      case `invalid_epoch_seq`:
        return this.text(400, `New epoch must start with sequence 0`)
      case `sequence_gap`:
        return this.text(409, `Producer sequence gap`, {
          [PRODUCER_EXPECTED_SEQ_HEADER]: String(result.expectedSeq),
          [PRODUCER_RECEIVED_SEQ_HEADER]: String(result.receivedSeq),
        })
      case `stream_closed`: {
        const meta = this.store.getMetaRaw()
        return this.text(409, `Stream is closed`, {
          [STREAM_CLOSED_HEADER]: `true`,
          [STREAM_OFFSET_HEADER]: meta?.currentOffset ?? ``,
        })
      }
    }
  }

  // ==========================================================================
  // DELETE
  // ==========================================================================

  private async handleDelete(_path: string): Promise<Response> {
    const meta = await this.getMeta(Date.now())
    if (!meta) {
      return this.text(404, `Stream not found`)
    }
    if (meta.softDeleted) {
      return this.text(410, `Stream is gone`)
    }
    if (this.store.forkEdgeCount() > 0) {
      // Active forks reference this stream: soft-delete so fork readers
      // can still stitch through it.
      this.store.setSoftDeleted()
      this.notifyClosed()
      return this.respond(204, {})
    }
    await this.purgeStream(meta)
    return this.respond(204, {})
  }

  // ==========================================================================
  // Expiry
  // ==========================================================================

  /**
   * Read meta with lazy expiry: an expired stream is purged (and its
   * source reference released) and reads as absent — unless forks still
   * reference it, in which case it is soft-deleted instead.
   */
  private async getMeta(now: number): Promise<StreamMeta | undefined> {
    const meta = this.store.getMetaRaw()
    if (!meta) return undefined
    if (this.store.isExpired(meta, now)) {
      if (this.store.forkEdgeCount() > 0) {
        if (!meta.softDeleted) this.store.setSoftDeleted()
        return { ...meta, softDeleted: true }
      }
      await this.purgeStream(meta)
      return undefined
    }
    return meta
  }

  private async purgeStream(meta: StreamMeta): Promise<void> {
    this.store.purge()
    this.cancelWaiters()
    await this.ctx.storage.deleteAlarm()
    this.lastArmedAlarm = undefined
    if (meta.forkedFrom !== undefined && meta.forkEdgeId !== undefined) {
      // Cascade: dropping this fork releases its edge on the source. The
      // release must not be lost if the RPC fails (that would pin the
      // source's reference forever), so queue it durably and retry from
      // the alarm handler on failure.
      this.store.enqueueGcRelease(
        meta.forkEdgeId,
        meta.forkedFrom,
        meta.forkSourceGen
      )
    }
    // Drain unconditionally: the queue can hold releases from an earlier
    // generation at this path (even a non-fork one), and the deleteAlarm
    // above just killed the retry alarm that would have delivered them.
    await this.flushGcReleases()
  }

  /**
   * Deliver queued forkRelease duties. The retry alarm is armed BEFORE
   * the RPCs so an isolate death mid-release cannot strand the queue —
   * nothing but the alarm ever picks it up. A stray alarm firing after
   * the queue drained is a cheap no-op.
   */
  private async flushGcReleases(): Promise<void> {
    if (this.store.pendingGcReleases().length === 0) return
    await this.armAlarmAt(Date.now() + 5_000)
    await this.processGcReleases()
  }

  /** Compensate creates interrupted after their remote acquire committed. */
  private async processForkIntents(): Promise<void> {
    if (this.store.getMetaRaw()) return
    for (const intent of this.store.pendingForkIntents()) {
      const stub = this.env.STREAMS.get(
        this.env.STREAMS.idFromName(intent.parentPath)
      )
      const params = JSON.parse(intent.paramsKey) as [string, string | null]
      try {
        // Repeating the idempotent acquire tells us its generation whether
        // the original RPC committed or not. Releasing it then makes either
        // outcome leak-free without requiring a client retry.
        const acquired = await stub.forkAcquire({
          edgeId: intent.edgeId,
          forkOffset: params[1] ?? undefined,
          contentTypeProvided: undefined,
        })
        if (acquired.ok) {
          this.store.enqueueGcRelease(
            intent.edgeId,
            intent.parentPath,
            acquired.sourceGeneration
          )
        }
        this.store.deleteForkIntent(intent.edgeId)
      } catch (err) {
        console.error(`fork intent reconciliation failed; will retry`, err)
        await this.armAlarmAt(Date.now() + 5_000)
      }
    }
  }

  /** Retry queued forkRelease calls; re-arm the alarm if any still fail. */
  private async processGcReleases(): Promise<void> {
    for (const pending of this.store.pendingGcReleases()) {
      const stub = this.env.STREAMS.get(
        this.env.STREAMS.idFromName(pending.parentPath)
      )
      try {
        await stub.forkRelease({
          edgeId: pending.edgeId,
          sourceGeneration: pending.sourceGen,
        })
        this.store.dequeueGcRelease(pending.edgeId)
      } catch (err) {
        console.error(
          `forkRelease failed; will retry via alarm`,
          pending.parentPath,
          err
        )
        await this.armAlarmAt(Date.now() + 5_000)
      }
    }
  }

  /**
   * The alarm time this DO last armed and believes is still pending in
   * storage. Cleared when the alarm fires or is deleted — a consumed alarm
   * must never suppress rearming (write-amplification guard only).
   */
  private lastArmedAlarm: number | undefined

  /** (Re-)arm the expiry alarm to match the stream's current expiry time. */
  private async syncExpiryAlarm(): Promise<void> {
    const meta = this.store.getMetaRaw()
    if (!meta) return
    const expiry = this.store.expiryTime(meta)
    if (expiry === undefined) return
    await this.armAlarmAt(expiry)
  }

  /**
   * Arm the DO alarm for `target` only when it is more than 500ms
   * earlier than the still-pending alarm. A later target keeps the
   * earlier pending alarm — it fires first and the handler re-syncs;
   * this is what absorbs per-read sliding-TTL touches. A target up to
   * 500ms before the pending alarm is absorbed too (firing up to 500ms
   * late), so near-identical rearms don't each cost a storage write.
   */
  private async armAlarmAt(target: number): Promise<void> {
    const pending =
      this.lastArmedAlarm !== undefined && this.lastArmedAlarm > Date.now()
        ? this.lastArmedAlarm
        : undefined
    if (pending !== undefined && pending <= target + 500) return
    await this.ctx.storage.setAlarm(target)
    this.lastArmedAlarm = target
  }

  // ==========================================================================
  // Long-poll waiters
  // ==========================================================================

  /**
   * Read messages after `afterOffset` for this stream, stitching inherited
   * source data when this stream is a fork.
   */
  private async readStream(
    meta: StreamMeta,
    afterOffset: string | undefined
  ): Promise<ReadBatch> {
    return this.readStitched(meta, afterOffset, undefined, undefined)
  }

  private async readStitched(
    meta: StreamMeta,
    afterOffset: string | undefined,
    capOffset: string | undefined,
    limit: number | undefined,
    byteBudget: number = MAX_READ_BATCH_BYTES
  ): Promise<ReadBatch> {
    const normalizedAfter =
      afterOffset === undefined || afterOffset === `-1`
        ? undefined
        : afterOffset
    const out: Array<StoredMessage> = []
    // One budget for the WHOLE stitched response: inherited segments spend
    // from it so response size cannot scale with fork depth.
    let remainingBytes = byteBudget

    if (
      meta.forkedFrom !== undefined &&
      meta.forkOffset !== undefined &&
      (normalizedAfter === undefined || normalizedAfter < meta.forkOffset)
    ) {
      const cap =
        capOffset === undefined || meta.forkOffset < capOffset
          ? meta.forkOffset
          : capOffset
      const stub = this.env.STREAMS.get(
        this.env.STREAMS.idFromName(meta.forkedFrom)
      )
      const inherited = await stub.readRange(
        normalizedAfter,
        cap,
        limit,
        remainingBytes
      )
      await testHooks.get(this)?.afterInheritedRead?.()
      // The parent RPC opens this object's input gate. Never combine its
      // result with local state from a delete/recreate generation.
      const current = this.store.getMetaRaw()
      if (!current || current.generation !== meta.generation) {
        return current
          ? this.readStitched(
              current,
              afterOffset,
              capOffset,
              limit,
              byteBudget
            )
          : { messages: [], capped: false }
      }
      out.push(...inherited.messages)
      for (const message of inherited.messages) {
        remainingBytes -= message.data.byteLength
      }
      if (inherited.capped) {
        // More inherited data remains: return the partial batch and let
        // the reader continue from its Stream-Next-Offset.
        return { messages: out, capped: true }
      }
      if (limit !== undefined && out.length >= limit) {
        return { messages: out.slice(0, limit), capped: true }
      }
      if (remainingBytes <= 0 && out.length > 0) {
        return { messages: out, capped: true }
      }
    }

    const remaining = limit === undefined ? undefined : limit - out.length
    const own = this.store.readMessagesRange(
      normalizedAfter,
      capOffset,
      remaining,
      remainingBytes,
      // The always-return-progress exception for an oversized first
      // message applies only when nothing has been emitted yet.
      out.length === 0
    )
    out.push(...own.messages)
    return { messages: out, capped: own.capped }
  }

  private async waitForMessages(
    offset: string,
    timeoutMs: number
  ): Promise<WaitResult> {
    // Fork inherited range: return the stitched data immediately rather
    // than waiting (source appends never wake fork waiters).
    const forkMeta = this.store.getMetaRaw()
    if (
      forkMeta?.forkedFrom !== undefined &&
      forkMeta.forkOffset !== undefined &&
      offset !== `-1` &&
      offset < forkMeta.forkOffset
    ) {
      const stitched = await this.readStream(forkMeta, offset)
      return {
        messages: stitched.messages,
        timedOut: false,
        streamClosed: false,
        capped: stitched.capped,
      }
    }
    if (forkMeta?.forkedFrom !== undefined && offset === `-1`) {
      const stitched = await this.readStream(forkMeta, undefined)
      if (stitched.messages.length > 0) {
        return {
          messages: stitched.messages,
          timedOut: false,
          streamClosed: false,
          capped: stitched.capped,
        }
      }
    }

    const initial = this.store.readMessages(
      offset === `-1` ? undefined : offset,
      MAX_READ_BATCH_BYTES
    )
    if (initial.messages.length > 0) {
      return {
        messages: initial.messages,
        timedOut: false,
        streamClosed: false,
        capped: initial.capped,
      }
    }

    const meta = this.store.getMetaRaw()
    if (!meta) {
      return Promise.resolve({
        messages: [],
        timedOut: false,
        streamClosed: false,
        capped: false,
      })
    }
    if (meta.closed && offset === meta.currentOffset) {
      return Promise.resolve({
        messages: [],
        timedOut: false,
        streamClosed: true,
        capped: false,
      })
    }

    return new Promise<WaitResult>((resolve) => {
      const waiter: PendingWaiter = {
        offset,
        resolve: (batch) => {
          clearTimeout(timeoutId)
          this.removeWaiter(waiter)
          const current = this.store.getMetaRaw()
          const streamClosed =
            current?.closed === true && batch.messages.length === 0
          resolve({
            messages: batch.messages,
            timedOut: false,
            streamClosed,
            capped: batch.capped,
          })
        },
      }

      const timeoutId = setTimeout(() => {
        this.removeWaiter(waiter)
        const current = this.store.getMetaRaw()
        resolve({
          messages: [],
          timedOut: true,
          streamClosed: current?.closed === true,
          capped: false,
        })
      }, timeoutMs)

      this.waiters.push(waiter)
    })
  }

  private notifyAppend(): void {
    for (const waiter of [...this.waiters]) {
      const batch = this.store.readMessages(
        waiter.offset === `-1` ? undefined : waiter.offset,
        MAX_READ_BATCH_BYTES
      )
      if (batch.messages.length > 0) {
        waiter.resolve(batch)
      }
    }
  }

  private notifyClosed(): void {
    for (const waiter of [...this.waiters]) {
      waiter.resolve({ messages: [], capped: false })
    }
  }

  private cancelWaiters(): void {
    for (const waiter of [...this.waiters]) {
      waiter.resolve({ messages: [], capped: false })
    }
    this.waiters = []
  }

  private removeWaiter(waiter: PendingWaiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index !== -1) {
      this.waiters.splice(index, 1)
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async readBody(request: Request): Promise<Uint8Array | `too_large`> {
    const body = request.body
    const lengthHeader = request.headers.get(`content-length`)
    if (lengthHeader !== null) {
      const length = Number(lengthHeader)
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        await this.drainBody(body)
        return `too_large`
      }
    }
    if (body === null) {
      return new Uint8Array(0)
    }
    // workers-types leaves ReadableStream's chunk type as `any`; a request
    // body stream always yields bytes.
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const chunks: Array<Uint8Array> = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await this.drainReader(reader)
        return `too_large`
      }
      chunks.push(value)
    }
    return concatBytes(chunks)
  }

  /**
   * Consume and discard the rest of an oversized upload so the 413 can be
   * delivered cleanly — responding while the client is still writing
   * resets the connection (the client sees EPIPE instead of the 413).
   */
  private async drainBody(
    body: ReadableStream<Uint8Array> | null
  ): Promise<void> {
    if (body === null) return
    await this.drainReader(body.getReader())
  }

  private async drainReader(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  }

  private makeEtag(
    startOffset: string,
    endOffset: string,
    closed: boolean
  ): string {
    const path = this.pathForEtag()
    const closedSuffix = closed ? `:c` : ``
    return `"${base64FromString(path)}:${startOffset}:${endOffset}${closedSuffix}"`
  }

  /**
   * The ETag only needs a stable per-stream identifier; the DO's own ID
   * serves (a DO cannot learn the name it was addressed by).
   */
  private pathForEtag(): string {
    return this.ctx.id.toString()
  }

  /** Standard headers on every response (CORS + browser security). */
  private respond(
    status: number,
    headers: Record<string, string>,
    body?: BodyInit
  ): Response {
    const h = new Headers(headers)
    h.set(`access-control-allow-origin`, `*`)
    h.set(
      `access-control-allow-methods`,
      `GET, POST, PUT, DELETE, HEAD, OPTIONS`
    )
    h.set(
      `access-control-allow-headers`,
      `content-type, authorization, If-None-Match, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq, Stream-Forked-From, Stream-Fork-Offset, Stream-Fork-Sub-Offset`
    )
    h.set(
      `access-control-expose-headers`,
      `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`
    )
    h.set(`x-content-type-options`, `nosniff`)
    h.set(`cross-origin-resource-policy`, `cross-origin`)
    return new Response(
      status === 204 || status === 304 ? null : (body ?? null),
      {
        status,
        headers: h,
      }
    )
  }

  private text(
    status: number,
    message: string,
    extraHeaders: Record<string, string> = {}
  ): Response {
    return this.respond(
      status,
      { "content-type": `text/plain`, ...extraHeaders },
      message
    )
  }
}

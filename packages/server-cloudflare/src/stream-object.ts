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
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
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
} from "./constants";
import { generateResponseCursor } from "./cursor";
import {
  JsonAppendError,
  concatBytes,
  formatJsonMessages,
  normalizeContentType,
  processJsonAppend,
} from "./json";
import { validateProducer } from "./producer";
import type { ProducerValidationResult } from "./producer";
import { SqliteStore } from "./store";
import type { ClosedBy, StoredMessage, StreamMeta } from "./store";

/**
 * How long a long-poll (or SSE keep-alive interval) waits for new data.
 * Must be comfortably under the conformance suite's 5s per-test budget
 * while longer than the ~500ms its delivery tests need (see NOTES.md).
 */
const LONG_POLL_TIMEOUT_MS = 2000;

/**
 * Maximum accepted request body. DO SQLite caps a single value at 2MB;
 * larger bodies get the protocol's 413 (the conformance suite accepts
 * 413 for its 10MB payload test).
 */
const MAX_BODY_BYTES = 1_900_000;

/** Offset params must be a sentinel or our `digits_digits` format. */
const VALID_OFFSET_PATTERN = /^(-1|now|\d+_\d+)$/;

/** Strict TTL: non-negative decimal integer, no leading zeros/sign/float. */
const TTL_PATTERN = /^(0|[1-9]\d*)$/;

const STRICT_INTEGER_REGEX = /^\d+$/;

/** Minimal shape check for a usable content-type value. */
const CONTENT_TYPE_SHAPE = /^[\w-]+\/[\w-]+/;

/** Fork offsets must match our concrete offset format. */
const VALID_FORK_OFFSET_PATTERN = /^\d+_\d+$/;

/** Sub-offset: non-negative decimal integer without leading zeros. */
const SUB_OFFSET_PATTERN = /^(0|[1-9]\d*)$/;

/** Inclusive upper bound beyond any real offset (for uncapped range reads). */
const MAX_OFFSET_CAP = "9999999999999999_9999999999999999";

const STREAM_FORKED_FROM_HEADER = "Stream-Forked-From";
const STREAM_FORK_OFFSET_HEADER = "Stream-Fork-Offset";
const STREAM_FORK_SUB_OFFSET_HEADER = "Stream-Fork-Sub-Offset";

export type ForkAcquireResult =
  | {
      ok: false;
      error:
        | "not_found"
        | "soft_deleted"
        | "content_type_mismatch"
        | "invalid_offset";
    }
  | {
      ok: true;
      forkOffset: string;
      contentType: string | undefined;
      ttlSeconds: number | undefined;
      expiresAt: string | undefined;
    };

/**
 * Encode a payload for SSE. Each line gets its own `data:` prefix; CR,
 * LF, and CRLF all split lines so payloads cannot inject fake SSE events.
 * No space after `data:` — clients strip exactly one leading space.
 */
function encodeSseData(payload: string): string {
  const lines = payload.split(/\r\n|\r|\n/);
  return lines.map((line) => `data:${line}`).join("\n") + "\n\n";
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64FromString(s: string): string {
  return base64FromBytes(new TextEncoder().encode(s));
}

interface WaitResult {
  messages: Array<StoredMessage>;
  timedOut: boolean;
  streamClosed: boolean;
}

interface PendingWaiter {
  offset: string;
  resolve: (messages: Array<StoredMessage>) => void;
}

interface ProducerHeaders {
  producerId: string;
  epoch: number;
  seq: number;
}

export class StreamObject extends DurableObject<Env> {
  private readonly store: SqliteStore;
  private waiters: Array<PendingWaiter> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqliteStore(ctx.storage.sql);
    this.store.ensureSchema();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    switch (request.method) {
      case "PUT":
        return this.handlePut(request, url, path);
      case "HEAD":
        return this.handleHead();
      case "GET":
        return this.handleGet(request, url);
      case "POST":
        return this.handlePost(request);
      case "DELETE":
        return this.handleDelete(path);
      default:
        return this.text(405, "Method not allowed");
    }
  }

  override async alarm(): Promise<void> {
    const meta = this.store.getMetaRaw();
    if (!meta) return;
    if (this.store.isExpired(meta, Date.now())) {
      if (meta.refCount > 0) {
        // Expired but referenced by forks: soft-delete instead of purging.
        if (!meta.softDeleted) this.store.setSoftDeleted();
      } else {
        await this.purgeStream(meta);
      }
    } else {
      await this.syncExpiryAlarm();
    }
  }

  // ==========================================================================
  // Fork RPC (called by other StreamObject instances via their stubs)
  // ==========================================================================

  /**
   * Validate this stream as a fork source and atomically take a reference
   * on it. Runs entirely inside this DO, so the content-type check and the
   * refcount increment cannot race (a mismatch must not leak a reference).
   */
  async forkAcquire(options: {
    forkOffset: string | undefined;
    contentTypeProvided: string | undefined;
  }): Promise<ForkAcquireResult> {
    const meta = await this.getMeta(Date.now());
    if (!meta) {
      return { ok: false, error: "not_found" };
    }
    if (meta.softDeleted) {
      return { ok: false, error: "soft_deleted" };
    }
    if (
      options.contentTypeProvided !== undefined &&
      options.contentTypeProvided.trim() !== "" &&
      normalizeContentType(options.contentTypeProvided) !==
        normalizeContentType(meta.contentType)
    ) {
      return { ok: false, error: "content_type_mismatch" };
    }

    const forkOffset = options.forkOffset ?? meta.currentOffset;
    if (forkOffset < ZERO_OFFSET || meta.currentOffset < forkOffset) {
      return { ok: false, error: "invalid_offset" };
    }

    this.store.incrementRef();
    return {
      ok: true,
      forkOffset,
      contentType: meta.contentType,
      ttlSeconds: meta.ttlSeconds,
      expiresAt: meta.expiresAt,
    };
  }

  /**
   * Release a fork's reference. When the last reference to a soft-deleted
   * stream drops, the stream is purged and the release cascades up the
   * fork chain.
   */
  async forkRelease(): Promise<void> {
    const meta = this.store.getMetaRaw();
    if (!meta) return;
    const newCount = this.store.decrementRef();
    if (newCount === 0 && meta.softDeleted) {
      await this.purgeStream(meta);
    }
  }

  /**
   * Read messages in (afterOffset, capOffset], stitching through the fork
   * chain. Reads raw state deliberately: forks must read through
   * soft-deleted (and expired-with-refs) sources.
   */
  async readRange(
    afterOffset: string | undefined,
    capOffset: string,
    limit?: number,
  ): Promise<Array<StoredMessage>> {
    const meta = this.store.getMetaRaw();
    if (!meta) return [];
    return this.readStitched(meta, afterOffset, capOffset, limit);
  }

  // ==========================================================================
  // PUT — create stream (idempotent)
  // ==========================================================================

  private async handlePut(
    request: Request,
    url: URL,
    path: string,
  ): Promise<Response> {
    let contentType = request.headers.get("content-type") ?? undefined;

    const forkedFrom =
      request.headers.get(STREAM_FORKED_FROM_HEADER) ?? undefined;
    const forkOffsetHeader =
      request.headers.get(STREAM_FORK_OFFSET_HEADER) ?? undefined;
    const forkSubOffsetHeader =
      request.headers.get(STREAM_FORK_SUB_OFFSET_HEADER) ?? undefined;

    // Sanitize content-type: empty/invalid falls back to the default —
    // except for forks, where an omitted Content-Type means "inherit".
    if (
      contentType === undefined ||
      contentType.trim() === "" ||
      !CONTENT_TYPE_SHAPE.test(contentType)
    ) {
      contentType = forkedFrom !== undefined ? undefined : "application/octet-stream";
    }

    const ttlHeader = request.headers.get(STREAM_TTL_HEADER) ?? undefined;
    const expiresAtHeader =
      request.headers.get(STREAM_EXPIRES_AT_HEADER) ?? undefined;
    const createClosed =
      (request.headers.get(STREAM_CLOSED_HEADER) ?? "").toLowerCase() ===
      "true";

    if (ttlHeader !== undefined && expiresAtHeader !== undefined) {
      return this.text(
        400,
        "Cannot specify both Stream-TTL and Stream-Expires-At",
      );
    }

    let ttlSeconds: number | undefined;
    if (ttlHeader !== undefined) {
      if (!TTL_PATTERN.test(ttlHeader)) {
        return this.text(400, "Invalid Stream-TTL value");
      }
      ttlSeconds = parseInt(ttlHeader, 10);
    }

    if (expiresAtHeader !== undefined) {
      const timestamp = new Date(expiresAtHeader);
      if (Number.isNaN(timestamp.getTime())) {
        return this.text(400, "Invalid Stream-Expires-At timestamp");
      }
    }

    if (
      forkOffsetHeader !== undefined &&
      !VALID_FORK_OFFSET_PATTERN.test(forkOffsetHeader)
    ) {
      return this.text(400, "Invalid Stream-Fork-Offset format");
    }

    let forkSubOffset: number | undefined;
    if (forkSubOffsetHeader !== undefined) {
      if (forkedFrom === undefined) {
        return this.text(400, "Stream-Fork-Sub-Offset requires Stream-Forked-From");
      }
      if (!SUB_OFFSET_PATTERN.test(forkSubOffsetHeader)) {
        return this.text(400, "Invalid Stream-Fork-Sub-Offset format");
      }
      forkSubOffset = parseInt(forkSubOffsetHeader, 10);
    }

    const body = await this.readBody(request);
    if (body === "too_large") {
      return this.text(413, "Payload too large");
    }

    const now = Date.now();
    const existing = await this.getMeta(now);

    if (existing) {
      if (existing.softDeleted) {
        return this.text(
          409,
          "stream was deleted but still has active forks — path cannot be reused until all forks are removed",
        );
      }
      const contentTypeMatches =
        (normalizeContentType(contentType) || "application/octet-stream") ===
        (normalizeContentType(existing.contentType) ||
          "application/octet-stream");
      const ttlMatches = ttlSeconds === existing.ttlSeconds;
      const expiresMatches = expiresAtHeader === existing.expiresAt;
      const closedMatches = createClosed === existing.closed;
      const forkedFromMatches = forkedFrom === existing.forkedFrom;
      // forkOffset only compared when explicitly supplied: an omitted
      // offset was resolved server-side at creation, so a second PUT
      // that also omits it stays idempotent.
      const forkOffsetMatches =
        forkOffsetHeader === undefined ||
        forkOffsetHeader === existing.forkOffset;
      const forkSubOffsetMatches =
        (forkSubOffset ?? 0) === (existing.forkSubOffset ?? 0);

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
            existing.contentType ?? contentType ?? "application/octet-stream",
          [STREAM_OFFSET_HEADER]: existing.currentOffset,
        };
        if (existing.closed) {
          headers[STREAM_CLOSED_HEADER] = "true";
        }
        return this.respond(200, headers);
      }
      return this.text(
        409,
        "Stream already exists with different configuration",
      );
    }

    if (forkedFrom !== undefined) {
      return this.createFork(url, path, {
        forkedFrom,
        forkOffsetHeader,
        forkSubOffset,
        contentType,
        ttlSeconds,
        expiresAt: expiresAtHeader,
        createClosed,
        body,
        now,
      });
    }

    // Process initial data BEFORE creating meta so an invalid JSON body
    // leaves no stream behind.
    const resolvedContentType = contentType ?? "application/octet-stream";
    let initialPayload: Uint8Array | undefined;
    if (body.length > 0) {
      if (normalizeContentType(resolvedContentType) === "application/json") {
        try {
          initialPayload = processJsonAppend(body, true);
        } catch (err) {
          if (err instanceof JsonAppendError) {
            return this.text(400, err.message);
          }
          throw err;
        }
      } else {
        initialPayload = body;
      }
    }

    this.store.createMeta({
      contentType: resolvedContentType,
      ttlSeconds,
      expiresAt: expiresAtHeader,
      closed: createClosed,
      now,
    });

    let currentOffset = this.store.getMetaRaw()?.currentOffset ?? "";
    if (initialPayload !== undefined && initialPayload.length > 0) {
      currentOffset = this.store.appendMessage(currentOffset, initialPayload, now);
    }

    await this.syncExpiryAlarm();

    const headers: Record<string, string> = {
      "content-type": resolvedContentType,
      [STREAM_OFFSET_HEADER]: currentOffset,
      location: `${url.origin}${path}`,
    };
    if (createClosed) {
      headers[STREAM_CLOSED_HEADER] = "true";
    }
    return this.respond(201, headers);
  }

  /** Create this stream as a fork of another stream. */
  private async createFork(
    url: URL,
    path: string,
    options: {
      forkedFrom: string;
      forkOffsetHeader: string | undefined;
      forkSubOffset: number | undefined;
      contentType: string | undefined;
      ttlSeconds: number | undefined;
      expiresAt: string | undefined;
      createClosed: boolean;
      body: Uint8Array;
      now: number;
    },
  ): Promise<Response> {
    const { forkedFrom, now } = options;

    // A stream cannot fork from itself (calling our own stub would
    // deadlock); the reference server reports this as source-not-found.
    if (forkedFrom === path) {
      return this.text(404, "Source stream not found");
    }

    const sourceStub = this.env.STREAMS.get(
      this.env.STREAMS.idFromName(forkedFrom),
    );
    const acquired = await sourceStub.forkAcquire({
      forkOffset: options.forkOffsetHeader,
      contentTypeProvided: options.contentType,
    });

    if (!acquired.ok) {
      switch (acquired.error) {
        case "not_found":
          return this.text(404, "Source stream not found");
        case "soft_deleted":
          return this.text(
            409,
            "source stream was deleted but still has active forks",
          );
        case "content_type_mismatch":
          return this.text(409, "Content type mismatch with source stream");
        case "invalid_offset":
          return this.text(400, "Fork offset beyond source stream length");
      }
    }

    const release = async (): Promise<void> => {
      await sourceStub.forkRelease();
    };

    const resolvedContentType =
      options.contentType !== undefined && options.contentType.trim() !== ""
        ? options.contentType
        : acquired.contentType;
    const isJson =
      normalizeContentType(resolvedContentType) === "application/json";

    // Fork expiry: an explicit TTL or Expires-At wins; otherwise inherit
    // from the source (TTL preferred), giving forks independent lifetimes.
    let effectiveTtl = options.ttlSeconds;
    let effectiveExpiresAt = options.expiresAt;
    if (effectiveTtl === undefined && effectiveExpiresAt === undefined) {
      if (acquired.ttlSeconds !== undefined) {
        effectiveTtl = acquired.ttlSeconds;
      } else if (acquired.expiresAt !== undefined) {
        effectiveExpiresAt = acquired.expiresAt;
      }
    }

    // Resolve the sub-offset prefix (a synthetic first message holding the
    // leading slice of the source message at the fork point).
    let subOffsetPrefix: Uint8Array | undefined;
    if (options.forkSubOffset !== undefined && options.forkSubOffset > 0) {
      const past = await sourceStub.readRange(
        acquired.forkOffset,
        MAX_OFFSET_CAP,
        1,
      );
      const first = past[0];
      if (!first) {
        await release();
        return this.text(400, "Invalid fork sub-offset");
      }
      if (isJson) {
        const text = new TextDecoder().decode(first.data);
        const trimmed = text.endsWith(",") ? text.slice(0, -1) : text;
        let values: Array<unknown>;
        try {
          const parsed: unknown = JSON.parse(`[${trimmed}]`);
          if (!Array.isArray(parsed)) {
            throw new JsonAppendError("Invalid fork sub-offset");
          }
          values = parsed;
        } catch {
          await release();
          return this.text(400, "Invalid fork sub-offset");
        }
        if (options.forkSubOffset > values.length) {
          await release();
          return this.text(400, "Invalid fork sub-offset");
        }
        const prefix = values
          .slice(0, options.forkSubOffset)
          .map((v) => JSON.stringify(v));
        subOffsetPrefix = new TextEncoder().encode(prefix.join(",") + ",");
      } else {
        if (options.forkSubOffset > first.data.length) {
          await release();
          return this.text(400, "Invalid fork sub-offset");
        }
        subOffsetPrefix = first.data.slice(0, options.forkSubOffset);
      }
    }

    // Process initial body data before creating anything.
    let initialPayload: Uint8Array | undefined;
    if (options.body.length > 0) {
      if (isJson) {
        try {
          initialPayload = processJsonAppend(options.body, true);
        } catch (err) {
          if (err instanceof JsonAppendError) {
            await release();
            return this.text(400, err.message);
          }
          throw err;
        }
      } else {
        initialPayload = options.body;
      }
    }

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
    });

    let currentOffset = acquired.forkOffset;
    if (subOffsetPrefix !== undefined && subOffsetPrefix.length > 0) {
      currentOffset = this.store.appendMessage(currentOffset, subOffsetPrefix, now);
    }
    if (initialPayload !== undefined && initialPayload.length > 0) {
      currentOffset = this.store.appendMessage(currentOffset, initialPayload, now);
    }

    await this.syncExpiryAlarm();

    const headers: Record<string, string> = {
      "content-type": resolvedContentType ?? "application/octet-stream",
      [STREAM_OFFSET_HEADER]: currentOffset,
      location: `${url.origin}${path}`,
    };
    if (options.createClosed) {
      headers[STREAM_CLOSED_HEADER] = "true";
    }
    return this.respond(201, headers);
  }

  // ==========================================================================
  // HEAD — metadata only; must NOT reset the sliding TTL
  // ==========================================================================

  private async handleHead(): Promise<Response> {
    const meta = await this.getMeta(Date.now());
    if (!meta) {
      return this.respond(404, { "content-type": "text/plain" });
    }
    if (meta.softDeleted) {
      return this.respond(410, { "content-type": "text/plain" });
    }

    const headers: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: meta.currentOffset,
      "cache-control": "no-store",
    };
    if (meta.contentType !== undefined) {
      headers["content-type"] = meta.contentType;
    }
    if (meta.closed) {
      headers[STREAM_CLOSED_HEADER] = "true";
    }
    if (meta.ttlSeconds !== undefined) {
      headers[STREAM_TTL_HEADER] = String(meta.ttlSeconds);
    }
    if (meta.expiresAt !== undefined) {
      headers[STREAM_EXPIRES_AT_HEADER] = meta.expiresAt;
    }
    headers["etag"] = this.makeEtag("-1", meta.currentOffset, meta.closed);

    return this.respond(200, headers);
  }

  // ==========================================================================
  // GET — catch-up reads, long-poll, SSE
  // ==========================================================================

  private async handleGet(request: Request, url: URL): Promise<Response> {
    const now = Date.now();
    const meta = await this.getMeta(now);
    if (!meta) {
      return this.text(404, "Stream not found");
    }
    if (meta.softDeleted) {
      return this.text(410, "Stream is gone");
    }

    const offsetParam = url.searchParams.get(OFFSET_QUERY_PARAM) ?? undefined;
    const live = url.searchParams.get(LIVE_QUERY_PARAM);
    const cursor = url.searchParams.get(CURSOR_QUERY_PARAM) ?? undefined;

    if (offsetParam !== undefined) {
      if (offsetParam === "") {
        return this.text(400, "Empty offset parameter");
      }
      if (url.searchParams.getAll(OFFSET_QUERY_PARAM).length > 1) {
        return this.text(400, "Multiple offset parameters not allowed");
      }
      if (!VALID_OFFSET_PATTERN.test(offsetParam)) {
        return this.text(400, "Invalid offset format");
      }
    }

    if ((live === "long-poll" || live === "sse") && offsetParam === undefined) {
      return this.text(
        400,
        `${live === "sse" ? "SSE" : "Long-poll"} requires offset parameter`,
      );
    }

    if (live === "sse") {
      const ct = normalizeContentType(meta.contentType);
      const isTextCompatible =
        ct.startsWith("text/") || ct === "application/json";
      const useBase64 = !isTextCompatible;
      const sseOffset =
        offsetParam === "now" ? meta.currentOffset : offsetParam ?? "-1";
      return this.handleSse(meta, sseOffset, cursor, useBase64);
    }

    // Catch-up read at the tail: empty response, never cached.
    if (offsetParam === "now" && live !== "long-poll") {
      const headers: Record<string, string> = {
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
        [STREAM_UP_TO_DATE_HEADER]: "true",
        "cache-control": "no-store",
      };
      if (meta.contentType !== undefined) {
        headers["content-type"] = meta.contentType;
      }
      if (meta.closed) {
        headers[STREAM_CLOSED_HEADER] = "true";
      }
      const isJsonMode =
        normalizeContentType(meta.contentType) === "application/json";
      return this.respond(200, headers, isJsonMode ? "[]" : "");
    }

    const effectiveOffset =
      offsetParam === "now" ? meta.currentOffset : offsetParam;

    let messages = await this.readStream(meta, effectiveOffset);
    let upToDate = true;
    this.store.touchAccess(now);
    await this.syncExpiryAlarm();

    const clientIsCaughtUp =
      (effectiveOffset !== undefined &&
        effectiveOffset === meta.currentOffset) ||
      offsetParam === "now";
    if (live === "long-poll" && clientIsCaughtUp && messages.length === 0) {
      if (meta.closed) {
        // Closed and at tail: EOF immediately, no waiting.
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: meta.currentOffset,
          [STREAM_UP_TO_DATE_HEADER]: "true",
          [STREAM_CLOSED_HEADER]: "true",
        });
      }

      const waitOffset = effectiveOffset ?? meta.currentOffset;
      const result = await this.waitForMessages(
        waitOffset,
        LONG_POLL_TIMEOUT_MS,
      );
      this.store.touchAccess(Date.now());
      await this.syncExpiryAlarm();

      if (result.streamClosed && result.messages.length === 0) {
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: waitOffset,
          [STREAM_UP_TO_DATE_HEADER]: "true",
          [STREAM_CURSOR_HEADER]: generateResponseCursor(cursor),
          [STREAM_CLOSED_HEADER]: "true",
        });
      }

      if (result.timedOut) {
        const headers: Record<string, string> = {
          [STREAM_OFFSET_HEADER]: waitOffset,
          [STREAM_UP_TO_DATE_HEADER]: "true",
          [STREAM_CURSOR_HEADER]: generateResponseCursor(cursor),
        };
        if (this.store.getMetaRaw()?.closed === true) {
          headers[STREAM_CLOSED_HEADER] = "true";
        }
        return this.respond(204, headers);
      }

      messages = result.messages;
      upToDate = true;
    }

    // Build the response. Re-read meta: it may have changed during a wait.
    const freshMeta = this.store.getMetaRaw() ?? meta;
    const headers: Record<string, string> = {};
    if (freshMeta.contentType !== undefined) {
      headers["content-type"] = freshMeta.contentType;
    }

    const lastMessage = messages[messages.length - 1];
    const responseOffset = lastMessage?.offset ?? freshMeta.currentOffset;
    headers[STREAM_OFFSET_HEADER] = responseOffset;

    if (live === "long-poll") {
      headers[STREAM_CURSOR_HEADER] = generateResponseCursor(cursor);
    }
    if (upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = "true";
    }

    const clientAtTail = responseOffset === freshMeta.currentOffset;
    const closedSuffix = freshMeta.closed && clientAtTail && upToDate;
    if (closedSuffix) {
      headers[STREAM_CLOSED_HEADER] = "true";
    }

    const startOffset = offsetParam ?? "-1";
    const etag = this.makeEtag(startOffset, responseOffset, closedSuffix);
    headers["etag"] = etag;

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch !== null && ifNoneMatch === etag) {
      return this.respond(304, { etag });
    }

    const fragments = messages.map((m) => m.data);
    const body =
      normalizeContentType(freshMeta.contentType) === "application/json"
        ? formatJsonMessages(fragments)
        : concatBytes(fragments);

    return this.respond(200, headers, body);
  }

  // ==========================================================================
  // SSE
  // ==========================================================================

  private handleSse(
    meta: StreamMeta,
    initialOffset: string,
    cursor: string | undefined,
    useBase64: boolean,
  ): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const isJson =
      normalizeContentType(meta.contentType) === "application/json";

    // Pump in the background; the pending stream keeps the DO alive.
    // Write failures mean the client disconnected — the only sane
    // response is to stop pumping.
    void this.pumpSse(initialOffset, cursor, useBase64, isJson, writer)
      .catch(() => undefined)
      .finally(() => writer.close().catch(() => undefined));

    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (useBase64) {
      headers[STREAM_SSE_DATA_ENCODING_HEADER] = "base64";
    }
    return this.respond(200, headers, readable);
  }

  private async pumpSse(
    initialOffset: string,
    cursor: string | undefined,
    useBase64: boolean,
    isJson: boolean,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<void> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const write = (s: string): Promise<void> => writer.write(encoder.encode(s));

    let currentOffset = initialOffset;

    for (;;) {
      const loopMeta = this.store.getMetaRaw();
      if (!loopMeta) {
        // Stream deleted/expired mid-tail: nothing more to deliver.
        return;
      }
      const messages = await this.readStream(
        loopMeta,
        currentOffset === "-1" ? undefined : currentOffset,
      );

      // Batch this iteration's data events and the control event into ONE
      // write. Separate writes become separate transport chunks, and the
      // suite's SSE reader may stop between them mid-event (its stop
      // marker can appear inside a data payload), then fail to parse the
      // incomplete event.
      let frame = "";
      for (const message of messages) {
        let dataPayload: string;
        if (useBase64) {
          dataPayload = base64FromBytes(message.data);
        } else if (isJson) {
          dataPayload = decoder.decode(formatJsonMessages([message.data]));
        } else {
          dataPayload = decoder.decode(message.data);
        }
        frame += `event: data\n` + encodeSseData(dataPayload);
        currentOffset = message.offset;
      }

      const freshMeta = this.store.getMetaRaw();
      if (!freshMeta) {
        // Stream deleted/expired mid-tail: nothing more to deliver.
        return;
      }
      this.store.touchAccess(Date.now());
      await this.syncExpiryAlarm();

      const lastMessage = messages[messages.length - 1];
      const controlOffset = lastMessage?.offset ?? freshMeta.currentOffset;
      const clientAtTail = controlOffset === freshMeta.currentOffset;

      const controlData: Record<string, string | boolean> = {
        [SSE_OFFSET_FIELD]: controlOffset,
      };
      if (freshMeta.closed && clientAtTail) {
        // Final control event: streamCursor omitted, upToDate implied.
        controlData[SSE_CLOSED_FIELD] = true;
      } else {
        controlData[SSE_CURSOR_FIELD] = generateResponseCursor(cursor);
        controlData[SSE_UP_TO_DATE_FIELD] = true;
      }
      frame += `event: control\n` + encodeSseData(JSON.stringify(controlData));
      await write(frame);

      if (freshMeta.closed && clientAtTail) {
        return;
      }
      currentOffset = controlOffset;

      const result = await this.waitForMessages(
        currentOffset,
        LONG_POLL_TIMEOUT_MS,
      );
      this.store.touchAccess(Date.now());
      await this.syncExpiryAlarm();

      if (result.streamClosed && result.messages.length === 0) {
        const finalControl: Record<string, string | boolean> = {
          [SSE_OFFSET_FIELD]: currentOffset,
          [SSE_CLOSED_FIELD]: true,
        };
        await write(`event: control\n` + encodeSseData(JSON.stringify(finalControl)));
        return;
      }

      if (result.timedOut) {
        const afterWait = this.store.getMetaRaw();
        if (!afterWait) return;
        if (afterWait.closed) {
          const closedControl: Record<string, string | boolean> = {
            [SSE_OFFSET_FIELD]: currentOffset,
            [SSE_CLOSED_FIELD]: true,
          };
          await write(
            `event: control\n` + encodeSseData(JSON.stringify(closedControl)),
          );
          return;
        }
        const keepAlive: Record<string, string | boolean> = {
          [SSE_OFFSET_FIELD]: currentOffset,
          [SSE_CURSOR_FIELD]: generateResponseCursor(cursor),
          [SSE_UP_TO_DATE_FIELD]: true,
        };
        await write(`event: control\n` + encodeSseData(JSON.stringify(keepAlive)));
      }
      // Loop continues: read any new messages.
    }
  }

  // ==========================================================================
  // POST — append / close
  // ==========================================================================

  private async handlePost(request: Request): Promise<Response> {
    const contentType = request.headers.get("content-type") ?? undefined;
    const seq = request.headers.get(STREAM_SEQ_HEADER) ?? undefined;
    const closeStream =
      (request.headers.get(STREAM_CLOSED_HEADER) ?? "").toLowerCase() ===
      "true";

    const producerId = request.headers.get(PRODUCER_ID_HEADER) ?? undefined;
    const producerEpochStr =
      request.headers.get(PRODUCER_EPOCH_HEADER) ?? undefined;
    const producerSeqStr =
      request.headers.get(PRODUCER_SEQ_HEADER) ?? undefined;

    const hasAnyProducerHeader =
      producerId !== undefined ||
      producerEpochStr !== undefined ||
      producerSeqStr !== undefined;
    const hasAllProducerHeaders =
      producerId !== undefined &&
      producerEpochStr !== undefined &&
      producerSeqStr !== undefined;

    if (hasAnyProducerHeader && !hasAllProducerHeaders) {
      return this.text(
        400,
        "All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together",
      );
    }
    if (hasAllProducerHeaders && producerId === "") {
      return this.text(400, "Invalid Producer-Id: must not be empty");
    }

    let producer: ProducerHeaders | undefined;
    if (hasAllProducerHeaders) {
      if (!STRICT_INTEGER_REGEX.test(producerEpochStr)) {
        return this.text(
          400,
          "Invalid Producer-Epoch: must be a non-negative integer",
        );
      }
      const epoch = Number(producerEpochStr);
      if (!Number.isSafeInteger(epoch)) {
        return this.text(
          400,
          "Invalid Producer-Epoch: must be a non-negative integer",
        );
      }
      if (!STRICT_INTEGER_REGEX.test(producerSeqStr)) {
        return this.text(
          400,
          "Invalid Producer-Seq: must be a non-negative integer",
        );
      }
      const seqNum = Number(producerSeqStr);
      if (!Number.isSafeInteger(seqNum)) {
        return this.text(
          400,
          "Invalid Producer-Seq: must be a non-negative integer",
        );
      }
      producer = { producerId, epoch, seq: seqNum };
    }

    const body = await this.readBody(request);
    if (body === "too_large") {
      return this.text(413, "Payload too large");
    }

    const now = Date.now();

    // Close-only request (empty body + Stream-Closed: true). Content-Type
    // validation is skipped per protocol §5.2.
    if (body.length === 0 && closeStream) {
      return this.handleCloseOnly(producer, now);
    }

    if (body.length === 0) {
      return this.text(400, "Empty body");
    }

    if (contentType === undefined) {
      return this.text(400, "Content-Type header is required");
    }

    const meta = await this.getMeta(now);
    if (!meta) {
      return this.text(404, "Stream not found");
    }
    if (meta.softDeleted) {
      return this.text(410, "Stream is gone");
    }

    // Closed check comes first so clients always see Stream-Closed.
    if (meta.closed) {
      if (
        producer !== undefined &&
        meta.closedBy !== undefined &&
        meta.closedBy.producerId === producer.producerId &&
        meta.closedBy.epoch === producer.epoch &&
        meta.closedBy.seq === producer.seq
      ) {
        // Duplicate of the closing request — idempotent success.
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: meta.currentOffset,
          [STREAM_CLOSED_HEADER]: "true",
          [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
          [PRODUCER_SEQ_HEADER]: String(producer.seq),
        });
      }
      return this.text(409, "Stream is closed", {
        [STREAM_CLOSED_HEADER]: "true",
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
      });
    }

    // Content-type mismatch check (normalized, so charset params match).
    if (contentType !== undefined && meta.contentType !== undefined) {
      if (
        normalizeContentType(contentType) !==
        normalizeContentType(meta.contentType)
      ) {
        return this.text(409, "Content-type mismatch");
      }
    }

    // Producer validation runs BEFORE the Stream-Seq check so a retry
    // carrying both is deduplicated to 204 instead of a Stream-Seq 409.
    let producerResult: ProducerValidationResult | undefined;
    if (producer !== undefined) {
      const state = this.store.getProducerState(producer.producerId, now);
      producerResult = validateProducer(
        state,
        producer.producerId,
        producer.epoch,
        producer.seq,
        now,
      );
      if (producerResult.status !== "accepted") {
        return this.producerFailureResponse(producerResult, producer, false);
      }
    }

    // Stream-Seq writer coordination: byte-wise lexicographic, strictly
    // increasing.
    if (seq !== undefined) {
      if (meta.lastSeq !== undefined && seq <= meta.lastSeq) {
        return this.text(409, "Sequence conflict");
      }
    }

    // Process the payload (JSON validation) BEFORE committing any state.
    let payload = body;
    if (normalizeContentType(meta.contentType) === "application/json") {
      try {
        payload = processJsonAppend(body, false);
      } catch (err) {
        if (err instanceof JsonAppendError) {
          return this.text(400, err.message);
        }
        throw err;
      }
    }

    const newOffset = this.store.appendMessage(meta.currentOffset, payload, now);

    if (producerResult !== undefined && producerResult.status === "accepted") {
      this.store.commitProducerState(
        producerResult.producerId,
        producerResult.proposedState,
      );
    }
    if (seq !== undefined) {
      this.store.setLastSeq(seq);
    }

    let closedBy: ClosedBy | undefined;
    if (closeStream) {
      if (producer !== undefined) {
        closedBy = {
          producerId: producer.producerId,
          epoch: producer.epoch,
          seq: producer.seq,
        };
      }
      this.store.setClosed(closedBy);
    }

    this.store.touchAccess(now);
    await this.syncExpiryAlarm();

    // Data waiters are notified before close waiters so append-and-close
    // delivers the final message before the EOF signal.
    this.notifyAppend();
    if (closeStream) {
      this.notifyClosed();
    }

    const responseHeaders: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: newOffset,
    };
    if (producer !== undefined) {
      responseHeaders[PRODUCER_EPOCH_HEADER] = String(producer.epoch);
      responseHeaders[PRODUCER_SEQ_HEADER] = String(producer.seq);
    }
    if (closeStream) {
      responseHeaders[STREAM_CLOSED_HEADER] = "true";
    }
    // 200 for producer appends (with headers), 204 for plain appends.
    return this.respond(producer !== undefined ? 200 : 204, responseHeaders);
  }

  private async handleCloseOnly(
    producer: ProducerHeaders | undefined,
    now: number,
  ): Promise<Response> {
    const meta = await this.getMeta(now);
    if (!meta) {
      return this.text(404, "Stream not found");
    }
    if (meta.softDeleted) {
      return this.text(410, "Stream is gone");
    }

    if (producer === undefined) {
      // Simple idempotent close.
      this.store.setClosed(undefined);
      this.notifyClosed();
      return this.respond(204, {
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
        [STREAM_CLOSED_HEADER]: "true",
      });
    }

    if (meta.closed) {
      if (
        meta.closedBy !== undefined &&
        meta.closedBy.producerId === producer.producerId &&
        meta.closedBy.epoch === producer.epoch &&
        meta.closedBy.seq === producer.seq
      ) {
        return this.respond(204, {
          [STREAM_OFFSET_HEADER]: meta.currentOffset,
          [STREAM_CLOSED_HEADER]: "true",
          [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
          [PRODUCER_SEQ_HEADER]: String(producer.seq),
        });
      }
      // Already closed by a different request — conflict.
      return this.text(409, "Stream is closed", {
        [STREAM_CLOSED_HEADER]: "true",
        [STREAM_OFFSET_HEADER]: meta.currentOffset,
      });
    }

    const state = this.store.getProducerState(producer.producerId, now);
    const producerResult = validateProducer(
      state,
      producer.producerId,
      producer.epoch,
      producer.seq,
      now,
    );
    if (producerResult.status !== "accepted") {
      return this.producerFailureResponse(producerResult, producer, true);
    }

    this.store.commitProducerState(
      producerResult.producerId,
      producerResult.proposedState,
    );
    this.store.setClosed({
      producerId: producer.producerId,
      epoch: producer.epoch,
      seq: producer.seq,
    });
    this.notifyClosed();

    return this.respond(204, {
      [STREAM_OFFSET_HEADER]: meta.currentOffset,
      [STREAM_CLOSED_HEADER]: "true",
      [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
      [PRODUCER_SEQ_HEADER]: String(producer.seq),
    });
  }

  /** Map a non-accepted producer validation result to its response. */
  private producerFailureResponse(
    result: Exclude<ProducerValidationResult, { status: "accepted" }>,
    producer: ProducerHeaders,
    isCloseOnly: boolean,
  ): Response {
    switch (result.status) {
      case "duplicate": {
        const headers: Record<string, string> = {
          [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
          [PRODUCER_SEQ_HEADER]: String(result.lastSeq),
        };
        if (isCloseOnly) {
          const meta = this.store.getMetaRaw();
          headers[STREAM_OFFSET_HEADER] = meta?.currentOffset ?? "";
          if (meta?.closed === true) {
            headers[STREAM_CLOSED_HEADER] = "true";
          }
        }
        return this.respond(204, headers);
      }
      case "stale_epoch":
        return this.text(403, "Stale producer epoch", {
          [PRODUCER_EPOCH_HEADER]: String(result.currentEpoch),
        });
      case "invalid_epoch_seq":
        return this.text(400, "New epoch must start with sequence 0");
      case "sequence_gap":
        return this.text(409, "Producer sequence gap", {
          [PRODUCER_EXPECTED_SEQ_HEADER]: String(result.expectedSeq),
          [PRODUCER_RECEIVED_SEQ_HEADER]: String(result.receivedSeq),
        });
      case "stream_closed": {
        const meta = this.store.getMetaRaw();
        return this.text(409, "Stream is closed", {
          [STREAM_CLOSED_HEADER]: "true",
          [STREAM_OFFSET_HEADER]: meta?.currentOffset ?? "",
        });
      }
    }
  }

  // ==========================================================================
  // DELETE
  // ==========================================================================

  private async handleDelete(_path: string): Promise<Response> {
    const meta = await this.getMeta(Date.now());
    if (!meta) {
      return this.text(404, "Stream not found");
    }
    if (meta.softDeleted) {
      return this.text(410, "Stream is gone");
    }
    if (meta.refCount > 0) {
      // Active forks reference this stream: soft-delete so fork readers
      // can still stitch through it.
      this.store.setSoftDeleted();
      this.notifyClosed();
      return this.respond(204, {});
    }
    await this.purgeStream(meta);
    return this.respond(204, {});
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
    const meta = this.store.getMetaRaw();
    if (!meta) return undefined;
    if (this.store.isExpired(meta, now)) {
      if (meta.refCount > 0) {
        if (!meta.softDeleted) this.store.setSoftDeleted();
        return { ...meta, softDeleted: true };
      }
      await this.purgeStream(meta);
      return undefined;
    }
    return meta;
  }

  private async purgeStream(meta: StreamMeta): Promise<void> {
    this.store.purge();
    this.cancelWaiters();
    await this.ctx.storage.deleteAlarm();
    if (meta.forkedFrom !== undefined) {
      // Cascade: dropping this fork releases its reference on the source.
      const stub = this.env.STREAMS.get(
        this.env.STREAMS.idFromName(meta.forkedFrom),
      );
      await stub.forkRelease();
    }
  }

  /** (Re-)arm the expiry alarm to match the stream's current expiry time. */
  private async syncExpiryAlarm(): Promise<void> {
    const meta = this.store.getMetaRaw();
    if (!meta) return;
    const expiry = this.store.expiryTime(meta);
    if (expiry !== undefined) {
      await this.ctx.storage.setAlarm(expiry);
    }
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
    afterOffset: string | undefined,
  ): Promise<Array<StoredMessage>> {
    return this.readStitched(meta, afterOffset, undefined, undefined);
  }

  private async readStitched(
    meta: StreamMeta,
    afterOffset: string | undefined,
    capOffset: string | undefined,
    limit: number | undefined,
  ): Promise<Array<StoredMessage>> {
    const normalizedAfter =
      afterOffset === undefined || afterOffset === "-1"
        ? undefined
        : afterOffset;
    const out: Array<StoredMessage> = [];

    if (
      meta.forkedFrom !== undefined &&
      meta.forkOffset !== undefined &&
      (normalizedAfter === undefined || normalizedAfter < meta.forkOffset)
    ) {
      const cap =
        capOffset === undefined || meta.forkOffset < capOffset
          ? meta.forkOffset
          : capOffset;
      const stub = this.env.STREAMS.get(
        this.env.STREAMS.idFromName(meta.forkedFrom),
      );
      const inherited = await stub.readRange(normalizedAfter, cap, limit);
      out.push(...inherited);
      if (limit !== undefined && out.length >= limit) {
        return out.slice(0, limit);
      }
    }

    const remaining = limit === undefined ? undefined : limit - out.length;
    const own = this.store.readMessagesRange(
      normalizedAfter,
      capOffset,
      remaining,
    );
    out.push(...own);
    return out;
  }

  private async waitForMessages(
    offset: string,
    timeoutMs: number,
  ): Promise<WaitResult> {
    // Fork inherited range: return the stitched data immediately rather
    // than waiting (source appends never wake fork waiters).
    const forkMeta = this.store.getMetaRaw();
    if (
      forkMeta?.forkedFrom !== undefined &&
      forkMeta.forkOffset !== undefined &&
      offset !== "-1" &&
      offset < forkMeta.forkOffset
    ) {
      const stitched = await this.readStream(forkMeta, offset);
      return { messages: stitched, timedOut: false, streamClosed: false };
    }
    if (forkMeta?.forkedFrom !== undefined && offset === "-1") {
      const stitched = await this.readStream(forkMeta, undefined);
      if (stitched.length > 0) {
        return { messages: stitched, timedOut: false, streamClosed: false };
      }
    }

    const messages = this.store.readMessages(
      offset === "-1" ? undefined : offset,
    );
    if (messages.length > 0) {
      return Promise.resolve({ messages, timedOut: false, streamClosed: false });
    }

    const meta = this.store.getMetaRaw();
    if (!meta) {
      return Promise.resolve({
        messages: [],
        timedOut: false,
        streamClosed: false,
      });
    }
    if (meta.closed && offset === meta.currentOffset) {
      return Promise.resolve({
        messages: [],
        timedOut: false,
        streamClosed: true,
      });
    }

    return new Promise<WaitResult>((resolve) => {
      const waiter: PendingWaiter = {
        offset,
        resolve: (msgs) => {
          clearTimeout(timeoutId);
          this.removeWaiter(waiter);
          const current = this.store.getMetaRaw();
          const streamClosed =
            current?.closed === true && msgs.length === 0;
          resolve({ messages: msgs, timedOut: false, streamClosed });
        },
      };

      const timeoutId = setTimeout(() => {
        this.removeWaiter(waiter);
        const current = this.store.getMetaRaw();
        resolve({
          messages: [],
          timedOut: true,
          streamClosed: current?.closed === true,
        });
      }, timeoutMs);

      this.waiters.push(waiter);
    });
  }

  private notifyAppend(): void {
    for (const waiter of [...this.waiters]) {
      const messages = this.store.readMessages(
        waiter.offset === "-1" ? undefined : waiter.offset,
      );
      if (messages.length > 0) {
        waiter.resolve(messages);
      }
    }
  }

  private notifyClosed(): void {
    for (const waiter of [...this.waiters]) {
      waiter.resolve([]);
    }
  }

  private cancelWaiters(): void {
    for (const waiter of [...this.waiters]) {
      waiter.resolve([]);
    }
    this.waiters = [];
  }

  private removeWaiter(waiter: PendingWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) {
      this.waiters.splice(index, 1);
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async readBody(request: Request): Promise<Uint8Array | "too_large"> {
    const body = request.body;
    const lengthHeader = request.headers.get("content-length");
    if (lengthHeader !== null) {
      const length = Number(lengthHeader);
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        await this.drainBody(body);
        return "too_large";
      }
    }
    if (body === null) {
      return new Uint8Array(0);
    }
    const reader = body.getReader();
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await this.drainReader(reader);
        return "too_large";
      }
      chunks.push(value);
    }
    return concatBytes(chunks);
  }

  /**
   * Consume and discard the rest of an oversized upload so the 413 can be
   * delivered cleanly — responding while the client is still writing
   * resets the connection (the client sees EPIPE instead of the 413).
   */
  private async drainBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (body === null) return;
    await this.drainReader(body.getReader());
  }

  private async drainReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  }

  private makeEtag(
    startOffset: string,
    endOffset: string,
    closed: boolean,
  ): string {
    const path = this.pathForEtag();
    const closedSuffix = closed ? ":c" : "";
    return `"${base64FromString(path)}:${startOffset}:${endOffset}${closedSuffix}"`;
  }

  /**
   * The ETag only needs a stable per-stream identifier; the DO's own ID
   * serves (a DO cannot learn the name it was addressed by).
   */
  private pathForEtag(): string {
    return this.ctx.id.toString();
  }

  /** Standard headers on every response (CORS + browser security). */
  private respond(
    status: number,
    headers: Record<string, string>,
    body?: BodyInit,
  ): Response {
    const h = new Headers(headers);
    h.set("access-control-allow-origin", "*");
    h.set(
      "access-control-allow-methods",
      "GET, POST, PUT, DELETE, HEAD, OPTIONS",
    );
    h.set(
      "access-control-allow-headers",
      "content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq, Stream-Forked-From, Stream-Fork-Offset, Stream-Fork-Sub-Offset",
    );
    h.set(
      "access-control-expose-headers",
      "Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary",
    );
    h.set("x-content-type-options", "nosniff");
    h.set("cross-origin-resource-policy", "cross-origin");
    return new Response(status === 204 || status === 304 ? null : body ?? null, {
      status,
      headers: h,
    });
  }

  private text(
    status: number,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): Response {
    return this.respond(
      status,
      { "content-type": "text/plain", ...extraHeaders },
      message,
    );
  }
}

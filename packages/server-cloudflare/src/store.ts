/**
 * SQLite-backed stream storage for a single stream (one Durable Object
 * instance per stream).
 *
 * Storage semantics are ported from the Durable Streams reference server
 * (packages/server/src/store.ts, Apache-2.0, Durable Stream contributors),
 * re-implemented on Durable Object SQLite. The DO's single-threaded
 * execution replaces the reference server's promise-chain locks: every
 * read-modify-write here is synchronous (no awaits), so it is atomic
 * with respect to other requests.
 */

import { FRAME_OVERHEAD, ZERO_OFFSET } from "./constants";
import type { ProducerState } from "./producer";

/** TTL for producer state cleanup (7 days), matching the reference server. */
const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClosedBy {
  producerId: string;
  epoch: number;
  seq: number;
}

export interface StreamMeta {
  /** Random id minted at creation; distinguishes delete+recreate generations. */
  generation: string;
  contentType: string | undefined;
  ttlSeconds: number | undefined;
  expiresAt: string | undefined;
  closed: boolean;
  closedBy: ClosedBy | undefined;
  currentOffset: string;
  lastSeq: string | undefined;
  createdAt: number;
  lastAccessedAt: number;
  /** Source stream path when this stream is a fork. */
  forkedFrom: string | undefined;
  /** Divergence offset from the source (same offset space). */
  forkOffset: string | undefined;
  /** User-supplied sub-offset, stored verbatim for idempotency matching. */
  forkSubOffset: number | undefined;
  /** Number of forks referencing this stream. */
  refCount: number;
  /** Logically deleted but retained for fork readers (410 Gone). */
  softDeleted: boolean;
}

export interface StoredMessage {
  data: Uint8Array;
  /** The offset AFTER this message (matches the reference data model). */
  offset: string;
}

export interface ReadBatch {
  messages: StoredMessage[];
  /** True when the read stopped early (limit/byte budget) — more may remain. */
  capped: boolean;
}

interface MetaRow extends Record<string, SqlStorageValue> {
  gen: string;
  content_type: string | null;
  ttl_seconds: number | null;
  expires_at: string | null;
  closed: number;
  closed_by: string | null;
  current_offset: string;
  last_seq: string | null;
  created_at: number;
  last_accessed_at: number;
  forked_from: string | null;
  fork_offset: string | null;
  fork_sub_offset: number | null;
  ref_count: number;
  soft_deleted: number;
}

interface MessageRow extends Record<string, SqlStorageValue> {
  msg_offset: string;
  data: ArrayBuffer;
}

interface ProducerRow extends Record<string, SqlStorageValue> {
  epoch: number;
  last_seq: number;
  last_updated: number;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function parseClosedBy(json: string | null): ClosedBy | undefined {
  if (json === null) return undefined;
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record: Partial<Record<keyof ClosedBy, unknown>> = parsed;
  const { producerId, epoch, seq } = record;
  if (
    typeof producerId === "string" &&
    typeof epoch === "number" &&
    typeof seq === "number"
  ) {
    return { producerId, epoch, seq };
  }
  return undefined;
}

/** Compute the offset after appending `payloadLength` bytes at `currentOffset`. */
export function advanceOffset(
  currentOffset: string,
  payloadLength: number,
): string {
  const parts = currentOffset.split("_");
  const readSeq = Number(parts[0]);
  const byteOffset = Number(parts[1]);
  const newByteOffset = byteOffset + FRAME_OVERHEAD + payloadLength;
  return `${String(readSeq).padStart(16, "0")}_${String(newByteOffset).padStart(16, "0")}`;
}

export class SqliteStore {
  constructor(private readonly sql: SqlStorage) {}

  ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        gen TEXT NOT NULL,
        content_type TEXT,
        ttl_seconds INTEGER,
        expires_at TEXT,
        closed INTEGER NOT NULL DEFAULT 0,
        closed_by TEXT,
        current_offset TEXT NOT NULL,
        last_seq TEXT,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        forked_from TEXT,
        fork_offset TEXT,
        fork_sub_offset INTEGER,
        ref_count INTEGER NOT NULL DEFAULT 0,
        soft_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        msg_offset TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS producers (
        producer_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        last_updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gc_queue (
        parent_path TEXT PRIMARY KEY
      );
    `);
  }

  /** Raw meta read with no expiry handling. */
  getMetaRaw(): StreamMeta | undefined {
    const rows = this.sql
      .exec<MetaRow>(`SELECT * FROM meta WHERE id = 1`)
      .toArray();
    const row = rows[0];
    if (!row) return undefined;
    return {
      generation: row.gen,
      contentType: row.content_type ?? undefined,
      ttlSeconds: row.ttl_seconds ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      closed: row.closed !== 0,
      closedBy: parseClosedBy(row.closed_by),
      currentOffset: row.current_offset,
      lastSeq: row.last_seq ?? undefined,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      forkedFrom: row.forked_from ?? undefined,
      forkOffset: row.fork_offset ?? undefined,
      forkSubOffset: row.fork_sub_offset ?? undefined,
      refCount: row.ref_count,
      softDeleted: row.soft_deleted !== 0,
    };
  }

  /**
   * Check expiry (sliding TTL from last access, or absolute expires-at).
   * Invalid expires-at dates are treated as expired (fail closed).
   */
  isExpired(meta: StreamMeta, now: number): boolean {
    if (meta.expiresAt !== undefined) {
      const expiryTime = new Date(meta.expiresAt).getTime();
      if (!Number.isFinite(expiryTime) || now >= expiryTime) {
        return true;
      }
    }
    if (meta.ttlSeconds !== undefined) {
      if (now >= meta.lastAccessedAt + meta.ttlSeconds * 1000) {
        return true;
      }
    }
    return false;
  }

  /** The wall-clock time at which the stream will expire, if any. */
  expiryTime(meta: StreamMeta): number | undefined {
    let expiry: number | undefined;
    if (meta.expiresAt !== undefined) {
      const t = new Date(meta.expiresAt).getTime();
      if (Number.isFinite(t)) expiry = t;
    }
    if (meta.ttlSeconds !== undefined) {
      const t = meta.lastAccessedAt + meta.ttlSeconds * 1000;
      if (expiry === undefined || t < expiry) expiry = t;
    }
    return expiry;
  }

  createMeta(options: {
    contentType: string | undefined;
    ttlSeconds: number | undefined;
    expiresAt: string | undefined;
    closed: boolean;
    now: number;
    forkedFrom?: string | undefined;
    forkOffset?: string | undefined;
    forkSubOffset?: number | undefined;
  }): void {
    this.sql.exec(
      `INSERT INTO meta (id, gen, content_type, ttl_seconds, expires_at, closed, closed_by,
         current_offset, last_seq, created_at, last_accessed_at,
         forked_from, fork_offset, fork_sub_offset, ref_count, soft_deleted)
       VALUES (1, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 0, 0)`,
      crypto.randomUUID(),
      options.contentType ?? null,
      options.ttlSeconds ?? null,
      options.expiresAt ?? null,
      options.closed ? 1 : 0,
      options.forkedFrom !== undefined && options.forkOffset !== undefined
        ? options.forkOffset
        : ZERO_OFFSET,
      options.now,
      options.now,
      options.forkedFrom ?? null,
      options.forkOffset ?? null,
      options.forkSubOffset ?? null,
    );
  }

  /** Delete all stream state. The stream then reads as never-existing. */
  purge(): void {
    this.sql.exec(`DELETE FROM meta`);
    this.sql.exec(`DELETE FROM messages`);
    this.sql.exec(`DELETE FROM producers`);
  }

  touchAccess(now: number): void {
    this.sql.exec(`UPDATE meta SET last_accessed_at = ? WHERE id = 1`, now);
  }

  /**
   * Read messages strictly after `afterOffset` (all when undefined/"-1"),
   * bounded by `byteBudget` so unbounded streams cannot be buffered whole.
   */
  readMessages(afterOffset: string | undefined, byteBudget: number): ReadBatch {
    return this.readMessagesRange(
      afterOffset,
      undefined,
      undefined,
      byteBudget,
    );
  }

  /**
   * Read messages with `offset > afterOffset` and (when capped)
   * `offset <= capOffset`, oldest first. Stops at `limit` messages or once
   * `byteBudget` bytes have been collected (always returning at least one
   * message); `capped: true` means more data may remain.
   */
  readMessagesRange(
    afterOffset: string | undefined,
    capOffset: string | undefined,
    limit: number | undefined,
    byteBudget: number | undefined,
  ): ReadBatch {
    const after =
      afterOffset === undefined || afterOffset === "-1" ? "" : afterOffset;
    const conditions = ["msg_offset > ?"];
    const bindings: (string | number)[] = [after];
    if (capOffset !== undefined) {
      conditions.push("msg_offset <= ?");
      bindings.push(capOffset);
    }
    const query = `SELECT msg_offset, data FROM messages WHERE ${conditions.join(" AND ")} ORDER BY msg_offset ASC`;
    const cursor = this.sql.exec<MessageRow>(query, ...bindings);
    const messages: StoredMessage[] = [];
    let bytes = 0;
    let capped = false;
    for (const row of cursor) {
      if (limit !== undefined && messages.length >= limit) {
        capped = true;
        break;
      }
      const data = new Uint8Array(row.data);
      if (
        byteBudget !== undefined &&
        messages.length > 0 &&
        bytes + data.byteLength > byteBudget
      ) {
        capped = true;
        break;
      }
      messages.push({ offset: row.msg_offset, data });
      bytes += data.byteLength;
    }
    return { messages, capped };
  }

  setSoftDeleted(): void {
    this.sql.exec(`UPDATE meta SET soft_deleted = 1 WHERE id = 1`);
  }

  incrementRef(): void {
    this.sql.exec(`UPDATE meta SET ref_count = ref_count + 1 WHERE id = 1`);
  }

  /** Queue a parent path whose forkRelease RPC failed, for alarm retry. */
  enqueueGcRelease(parentPath: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gc_queue (parent_path) VALUES (?)`,
      parentPath,
    );
  }

  dequeueGcRelease(parentPath: string): void {
    this.sql.exec(`DELETE FROM gc_queue WHERE parent_path = ?`, parentPath);
  }

  pendingGcReleases(): string[] {
    return this.sql
      .exec<{ parent_path: string }>(`SELECT parent_path FROM gc_queue`)
      .toArray()
      .map((r) => r.parent_path);
  }

  /** Decrement the refcount (floored at 0) and return the new value. */
  decrementRef(): number {
    this.sql.exec(
      `UPDATE meta SET ref_count = MAX(ref_count - 1, 0) WHERE id = 1`,
    );
    const rows = this.sql
      .exec<{ ref_count: number }>(`SELECT ref_count FROM meta WHERE id = 1`)
      .toArray();
    return rows[0]?.ref_count ?? 0;
  }

  /**
   * Append processed payload bytes as one message, advancing the current
   * offset. Returns the new offset.
   */
  appendMessage(
    currentOffset: string,
    payload: Uint8Array,
    now: number,
  ): string {
    const newOffset = advanceOffset(currentOffset, payload.length);
    this.sql.exec(
      `INSERT INTO messages (msg_offset, data, ts) VALUES (?, ?, ?)`,
      newOffset,
      toArrayBuffer(payload),
      now,
    );
    this.sql.exec(`UPDATE meta SET current_offset = ? WHERE id = 1`, newOffset);
    return newOffset;
  }

  setLastSeq(seq: string): void {
    this.sql.exec(`UPDATE meta SET last_seq = ? WHERE id = 1`, seq);
  }

  setClosed(closedBy: ClosedBy | undefined): void {
    this.sql.exec(
      `UPDATE meta SET closed = 1, closed_by = COALESCE(?, closed_by) WHERE id = 1`,
      closedBy === undefined ? null : JSON.stringify(closedBy),
    );
  }

  getProducerState(producerId: string, now: number): ProducerState | undefined {
    // Clean up expired producer states on access (reference behavior).
    this.sql.exec(
      `DELETE FROM producers WHERE last_updated < ?`,
      now - PRODUCER_STATE_TTL_MS,
    );
    const rows = this.sql
      .exec<ProducerRow>(
        `SELECT epoch, last_seq, last_updated FROM producers WHERE producer_id = ?`,
        producerId,
      )
      .toArray();
    const row = rows[0];
    if (!row) return undefined;
    return {
      epoch: row.epoch,
      lastSeq: row.last_seq,
      lastUpdated: row.last_updated,
    };
  }

  commitProducerState(producerId: string, state: ProducerState): void {
    this.sql.exec(
      `INSERT INTO producers (producer_id, epoch, last_seq, last_updated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (producer_id) DO UPDATE SET
         epoch = excluded.epoch,
         last_seq = excluded.last_seq,
         last_updated = excluded.last_updated`,
      producerId,
      state.epoch,
      state.lastSeq,
      state.lastUpdated,
    );
  }
}

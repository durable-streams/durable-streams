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

import { FRAME_OVERHEAD, ZERO_OFFSET } from "./constants"
import type { ProducerState } from "./producer"

/** TTL for producer state cleanup (7 days), matching the reference server. */
const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ClosedBy {
  producerId: string
  epoch: number
  seq: number
}

export interface StreamMeta {
  /** Random id minted at creation; distinguishes delete+recreate generations. */
  generation: string
  contentType: string | undefined
  ttlSeconds: number | undefined
  expiresAt: string | undefined
  closed: boolean
  closedBy: ClosedBy | undefined
  currentOffset: string
  lastSeq: string | undefined
  createdAt: number
  lastAccessedAt: number
  /** Source stream path when this stream is a fork. */
  forkedFrom: string | undefined
  /** Divergence offset from the source (same offset space). */
  forkOffset: string | undefined
  /** User-supplied sub-offset, stored verbatim for idempotency matching. */
  forkSubOffset: number | undefined
  /** Stable id of this fork's edge onto its source (release identity). */
  forkEdgeId: string | undefined
  /** Source generation the edge was acquired under (release qualifier). */
  forkSourceGen: string | undefined
  /** Logically deleted but retained for fork readers (410 Gone). */
  softDeleted: boolean
}

export interface StoredMessage {
  data: Uint8Array
  /** The offset AFTER this message (matches the reference data model). */
  offset: string
}

export interface ReadBatch {
  messages: Array<StoredMessage>
  /** True when the read stopped early (limit/byte budget) — more may remain. */
  capped: boolean
}

interface MetaRow extends Record<string, SqlStorageValue> {
  gen: string
  content_type: string | null
  ttl_seconds: number | null
  expires_at: string | null
  closed: number
  closed_by: string | null
  current_offset: string
  last_seq: string | null
  created_at: number
  last_accessed_at: number
  forked_from: string | null
  fork_offset: string | null
  fork_sub_offset: number | null
  fork_edge_id: string | null
  fork_source_gen: string | null
  soft_deleted: number
}

interface MessageRow extends Record<string, SqlStorageValue> {
  msg_offset: string
  data: ArrayBuffer
}

interface ProducerRow extends Record<string, SqlStorageValue> {
  epoch: number
  last_seq: number
  last_updated: number
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function parseClosedBy(json: string | null): ClosedBy | undefined {
  if (json === null) return undefined
  const parsed: unknown = JSON.parse(json)
  if (parsed === null || typeof parsed !== `object`) return undefined
  const record: Partial<Record<keyof ClosedBy, unknown>> = parsed
  const { producerId, epoch, seq } = record
  if (
    typeof producerId === `string` &&
    typeof epoch === `number` &&
    typeof seq === `number`
  ) {
    return { producerId, epoch, seq }
  }
  return undefined
}

/** Compute the offset after appending `payloadLength` bytes at `currentOffset`. */
export function advanceOffset(
  currentOffset: string,
  payloadLength: number
): string {
  const parts = currentOffset.split(`_`)
  const readSeq = Number(parts[0])
  const byteOffset = Number(parts[1])
  const newByteOffset = byteOffset + FRAME_OVERHEAD + payloadLength
  return `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`
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
        fork_edge_id TEXT,
        fork_source_gen TEXT,
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
      -- Forks referencing THIS stream, one row per fork edge. A row's
      -- presence is the reference: insert-if-absent on acquire and
      -- delete-if-present on release make both retry-safe.
      CREATE TABLE IF NOT EXISTS fork_edges (
        edge_id TEXT PRIMARY KEY,
        fork_offset TEXT NOT NULL
      );
      -- Durable intent to acquire a fork edge, written BEFORE the remote
      -- acquire RPC so a create retry reuses the same edge identity.
      CREATE TABLE IF NOT EXISTS fork_intents (
        edge_id TEXT PRIMARY KEY,
        parent_path TEXT NOT NULL,
        params_key TEXT NOT NULL
      );
      -- forkRelease calls that must not be lost, keyed by edge and
      -- qualified by the source generation they were acquired under.
      CREATE TABLE IF NOT EXISTS gc_releases (
        edge_id TEXT PRIMARY KEY,
        parent_path TEXT NOT NULL,
        source_gen TEXT
      );
    `)
    // Additive migration for meta tables created before fork edges
    // existed (CREATE IF NOT EXISTS never alters an existing table).
    // Deliberately NOT migrated (this package has never been released;
    // only pre-edge dev/preview state is affected): legacy `ref_count`
    // values read as zero references, and rows in the abandoned
    // `gc_queue` table are dropped — pre-edge fork bookkeeping cannot be
    // mapped onto edge identities after the fact.
    const metaColumns = new Set(
      this.sql
        .exec<{ name: string }>(`SELECT name FROM pragma_table_info('meta')`)
        .toArray()
        .map((row) => row.name)
    )
    if (!metaColumns.has(`fork_edge_id`)) {
      this.sql.exec(`ALTER TABLE meta ADD COLUMN fork_edge_id TEXT`)
    }
    if (!metaColumns.has(`fork_source_gen`)) {
      this.sql.exec(`ALTER TABLE meta ADD COLUMN fork_source_gen TEXT`)
    }
  }

  /** Raw meta read with no expiry handling. */
  getMetaRaw(): StreamMeta | undefined {
    const rows = this.sql
      .exec<MetaRow>(`SELECT * FROM meta WHERE id = 1`)
      .toArray()
    const row = rows[0]
    if (!row) return undefined
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
      forkEdgeId: row.fork_edge_id ?? undefined,
      forkSourceGen: row.fork_source_gen ?? undefined,
      softDeleted: row.soft_deleted !== 0,
    }
  }

  /**
   * Number of forks referencing this stream. One row per fork edge, so
   * the count cannot drift from the references the way a counter could.
   */
  forkEdgeCount(): number {
    const rows = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM fork_edges`)
      .toArray()
    return rows[0]?.n ?? 0
  }

  /**
   * Check expiry (sliding TTL from last access, or absolute expires-at).
   * Invalid expires-at dates are treated as expired (fail closed).
   */
  isExpired(meta: StreamMeta, now: number): boolean {
    if (meta.expiresAt !== undefined) {
      const expiryTime = new Date(meta.expiresAt).getTime()
      if (!Number.isFinite(expiryTime) || now >= expiryTime) {
        return true
      }
    }
    if (meta.ttlSeconds !== undefined) {
      if (now >= meta.lastAccessedAt + meta.ttlSeconds * 1000) {
        return true
      }
    }
    return false
  }

  /** The wall-clock time at which the stream will expire, if any. */
  expiryTime(meta: StreamMeta): number | undefined {
    let expiry: number | undefined
    if (meta.expiresAt !== undefined) {
      const t = new Date(meta.expiresAt).getTime()
      if (Number.isFinite(t)) expiry = t
    }
    if (meta.ttlSeconds !== undefined) {
      const t = meta.lastAccessedAt + meta.ttlSeconds * 1000
      if (expiry === undefined || t < expiry) expiry = t
    }
    return expiry
  }

  createMeta(options: {
    contentType: string | undefined
    ttlSeconds: number | undefined
    expiresAt: string | undefined
    closed: boolean
    now: number
    forkedFrom?: string | undefined
    forkOffset?: string | undefined
    forkSubOffset?: number | undefined
    forkEdgeId?: string | undefined
    forkSourceGen?: string | undefined
  }): void {
    this.sql.exec(
      `INSERT INTO meta (id, gen, content_type, ttl_seconds, expires_at, closed, closed_by,
         current_offset, last_seq, created_at, last_accessed_at,
         forked_from, fork_offset, fork_sub_offset, fork_edge_id, fork_source_gen, soft_deleted)
       VALUES (1, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
      options.forkEdgeId ?? null,
      options.forkSourceGen ?? null
    )
  }

  /**
   * Delete all stream state. The stream then reads as never-existing.
   * Pending gc_releases and fork_intents survive on purpose: queued
   * releases must still reach the source, and a create retry must be able
   * to reuse its acquired edge identity.
   */
  purge(): void {
    this.sql.exec(`DELETE FROM meta`)
    this.sql.exec(`DELETE FROM messages`)
    this.sql.exec(`DELETE FROM producers`)
    this.sql.exec(`DELETE FROM fork_edges`)
  }

  touchAccess(now: number): void {
    this.sql.exec(`UPDATE meta SET last_accessed_at = ? WHERE id = 1`, now)
  }

  /**
   * Read messages strictly after `afterOffset` (all when undefined/"-1"),
   * bounded by `byteBudget` so unbounded streams cannot be buffered whole.
   */
  readMessages(afterOffset: string | undefined, byteBudget: number): ReadBatch {
    return this.readMessagesRange(afterOffset, undefined, undefined, byteBudget)
  }

  /**
   * Read messages with `offset > afterOffset` and (when a `capOffset` is
   * given) `offset <= capOffset`, oldest first. Stops at `limit` messages
   * or before adding a message would exceed `byteBudget`; `capped: true`
   * means more data may remain. A first message larger than the whole
   * budget is still returned (readers must always make progress) unless
   * `allowOversizedFirst` is false — stitched fork reads disable it when
   * the response already carries inherited data.
   */
  readMessagesRange(
    afterOffset: string | undefined,
    capOffset: string | undefined,
    limit: number | undefined,
    byteBudget: number | undefined,
    allowOversizedFirst: boolean = true
  ): ReadBatch {
    const after =
      afterOffset === undefined || afterOffset === `-1` ? `` : afterOffset
    const conditions = [`msg_offset > ?`]
    const bindings: Array<string | number> = [after]
    if (capOffset !== undefined) {
      conditions.push(`msg_offset <= ?`)
      bindings.push(capOffset)
    }
    const query = `SELECT msg_offset, data FROM messages WHERE ${conditions.join(` AND `)} ORDER BY msg_offset ASC`
    const cursor = this.sql.exec<MessageRow>(query, ...bindings)
    const messages: Array<StoredMessage> = []
    let bytes = 0
    let capped = false
    for (const row of cursor) {
      if (limit !== undefined && messages.length >= limit) {
        capped = true
        break
      }
      const data = new Uint8Array(row.data)
      if (
        byteBudget !== undefined &&
        (messages.length > 0 || !allowOversizedFirst) &&
        bytes + data.byteLength > byteBudget
      ) {
        capped = true
        break
      }
      messages.push({ offset: row.msg_offset, data })
      bytes += data.byteLength
    }
    return { messages, capped }
  }

  setSoftDeleted(): void {
    this.sql.exec(`UPDATE meta SET soft_deleted = 1 WHERE id = 1`)
  }

  /**
   * Record a fork edge if absent (idempotent acquire) and return the
   * edge's fork offset — the stored one when the edge already existed, so
   * an acquire retry cannot re-resolve to a different offset.
   */
  insertForkEdge(edgeId: string, forkOffset: string): string {
    this.sql.exec(
      `INSERT OR IGNORE INTO fork_edges (edge_id, fork_offset) VALUES (?, ?)`,
      edgeId,
      forkOffset
    )
    const rows = this.sql
      .exec<{
        fork_offset: string
      }>(`SELECT fork_offset FROM fork_edges WHERE edge_id = ?`, edgeId)
      .toArray()
    return rows[0]?.fork_offset ?? forkOffset
  }

  getForkEdge(edgeId: string): { forkOffset: string } | undefined {
    const rows = this.sql
      .exec<{
        fork_offset: string
      }>(`SELECT fork_offset FROM fork_edges WHERE edge_id = ?`, edgeId)
      .toArray()
    const row = rows[0]
    return row === undefined ? undefined : { forkOffset: row.fork_offset }
  }

  /** Drop a fork edge if present (idempotent release). */
  deleteForkEdge(edgeId: string): void {
    this.sql.exec(`DELETE FROM fork_edges WHERE edge_id = ?`, edgeId)
  }

  /** Look up a persisted fork-edge intent for these create parameters. */
  getForkIntent(paramsKey: string): string | undefined {
    const rows = this.sql
      .exec<{
        edge_id: string
      }>(`SELECT edge_id FROM fork_intents WHERE params_key = ?`, paramsKey)
      .toArray()
    return rows[0]?.edge_id
  }

  /** Persist an edge intent BEFORE the remote acquire RPC. */
  putForkIntent(edgeId: string, parentPath: string, paramsKey: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO fork_intents (edge_id, parent_path, params_key) VALUES (?, ?, ?)`,
      edgeId,
      parentPath,
      paramsKey
    )
  }

  deleteForkIntent(edgeId: string): void {
    this.sql.exec(`DELETE FROM fork_intents WHERE edge_id = ?`, edgeId)
  }

  pendingForkIntents(): Array<{
    edgeId: string
    parentPath: string
    paramsKey: string
  }> {
    return this.sql
      .exec<{
        edge_id: string
        parent_path: string
        params_key: string
      }>(`SELECT edge_id, parent_path, params_key FROM fork_intents`)
      .toArray()
      .map((row) => ({
        edgeId: row.edge_id,
        parentPath: row.parent_path,
        paramsKey: row.params_key,
      }))
  }

  /** Queue a forkRelease that must not be lost, for alarm retry. */
  enqueueGcRelease(
    edgeId: string,
    parentPath: string,
    sourceGen: string | undefined
  ): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gc_releases (edge_id, parent_path, source_gen) VALUES (?, ?, ?)`,
      edgeId,
      parentPath,
      sourceGen ?? null
    )
  }

  dequeueGcRelease(edgeId: string): void {
    this.sql.exec(`DELETE FROM gc_releases WHERE edge_id = ?`, edgeId)
  }

  pendingGcReleases(): Array<{
    edgeId: string
    parentPath: string
    sourceGen: string | undefined
  }> {
    return this.sql
      .exec<{
        edge_id: string
        parent_path: string
        source_gen: string | null
      }>(`SELECT edge_id, parent_path, source_gen FROM gc_releases`)
      .toArray()
      .map((r) => ({
        edgeId: r.edge_id,
        parentPath: r.parent_path,
        sourceGen: r.source_gen ?? undefined,
      }))
  }

  /**
   * Append processed payload bytes as one message, advancing the current
   * offset. Returns the new offset.
   */
  appendMessage(
    currentOffset: string,
    payload: Uint8Array,
    now: number
  ): string {
    const newOffset = advanceOffset(currentOffset, payload.length)
    this.sql.exec(
      `INSERT INTO messages (msg_offset, data, ts) VALUES (?, ?, ?)`,
      newOffset,
      toArrayBuffer(payload),
      now
    )
    this.sql.exec(`UPDATE meta SET current_offset = ? WHERE id = 1`, newOffset)
    return newOffset
  }

  setLastSeq(seq: string): void {
    this.sql.exec(`UPDATE meta SET last_seq = ? WHERE id = 1`, seq)
  }

  setClosed(closedBy: ClosedBy | undefined): void {
    this.sql.exec(
      `UPDATE meta SET closed = 1, closed_by = COALESCE(?, closed_by) WHERE id = 1`,
      closedBy === undefined ? null : JSON.stringify(closedBy)
    )
  }

  getProducerState(producerId: string, now: number): ProducerState | undefined {
    // Clean up expired producer states on access (reference behavior).
    this.sql.exec(
      `DELETE FROM producers WHERE last_updated < ?`,
      now - PRODUCER_STATE_TTL_MS
    )
    const rows = this.sql
      .exec<ProducerRow>(
        `SELECT epoch, last_seq, last_updated FROM producers WHERE producer_id = ?`,
        producerId
      )
      .toArray()
    const row = rows[0]
    if (!row) return undefined
    return {
      epoch: row.epoch,
      lastSeq: row.last_seq,
      lastUpdated: row.last_updated,
    }
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
      state.lastUpdated
    )
  }
}

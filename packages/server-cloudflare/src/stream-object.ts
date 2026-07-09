/**
 * StreamObject — one Durable Object instance per stream.
 *
 * Holds all Durable Streams protocol semantics, backed by DO SQLite.
 * The DO input gate provides per-stream serialization; the output gate
 * confirms SQLite writes before responses escape (durability before ack).
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export class StreamObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content_type TEXT,
        ttl_seconds INTEGER,
        expires_at TEXT,
        closed INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        current_offset TEXT NOT NULL,
        last_seq TEXT,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        offset TEXT PRIMARY KEY,
        body BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS producers (
        producer_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        last_updated INTEGER NOT NULL
      );
    `);
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("Not implemented", { status: 501 });
  }
}

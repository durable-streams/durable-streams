/**
 * Regression test for the additive meta-table migration: a database
 * created before fork edges existed (meta has `ref_count`, lacks
 * `fork_edge_id`/`fork_source_gen`) must be upgraded in place by
 * ensureSchema — a broken ALTER would crash the DO constructor for
 * every stream holding pre-upgrade state.
 */
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { SqliteStore } from "../src/store"

describe(`schema migration`, () => {
  it(`upgrades a pre-fork-edge meta table in place`, async () => {
    const path = `/streams/migration-legacy`
    const stub = env.STREAMS.get(env.STREAMS.idFromName(path))

    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql
      // Recreate the OLD schema shape with a live row.
      sql.exec(`DROP TABLE IF EXISTS meta`)
      sql.exec(`
        CREATE TABLE meta (
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
        )
      `)
      sql.exec(
        `INSERT INTO meta (id, gen, content_type, current_offset, created_at, last_accessed_at, ref_count)
         VALUES (1, 'legacy-gen', 'text/plain', '0000000000000000_0000000000000000', ?, ?, 0)`,
        Date.now(),
        Date.now()
      )

      // Re-running ensureSchema (what the DO constructor does) must
      // migrate the old table without throwing...
      const store = new SqliteStore(sql)
      store.ensureSchema()

      // ...and the row must read back with the new columns defaulted.
      const meta = store.getMetaRaw()
      expect(meta).toBeDefined()
      expect(meta?.generation).toBe(`legacy-gen`)
      expect(meta?.forkEdgeId).toBeUndefined()
      expect(meta?.forkSourceGen).toBeUndefined()
    })

    // The stream must still serve requests end to end.
    const head = await stub.fetch(`http://do${path}`, { method: `HEAD` })
    expect(head.status).toBe(200)
    const appended = await stub.fetch(`http://do${path}`, {
      method: `POST`,
      headers: { "content-type": `text/plain` },
      body: `post-migration write`,
    })
    expect(appended.status).toBe(204)
  })
})

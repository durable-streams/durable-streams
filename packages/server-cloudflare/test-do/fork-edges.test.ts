/**
 * Regression tests for fork reference lifetime (direct DO access).
 *
 * Fork references cross Durable Object transaction boundaries: an RPC can
 * commit remotely while its response is lost, so the caller's retry MUST
 * be idempotent. References are therefore fork-edge rows with stable ids
 * (insert-if-absent / delete-if-present), qualified by the source
 * generation so a delayed release can never touch a recreated stream.
 */
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { StreamObject } from "../src/stream-object"

function stubFor(path: string): DurableObjectStub<StreamObject> {
  return env.STREAMS.get(env.STREAMS.idFromName(path))
}

async function createSource(
  path: string
): Promise<DurableObjectStub<StreamObject>> {
  const stub = stubFor(path)
  const created = await stub.fetch(`http://do${path}`, {
    method: `PUT`,
    headers: { "content-type": `text/plain` },
    body: `source data`,
  })
  expect(created.status).toBe(201)
  return stub
}

async function statusOf(
  stub: DurableObjectStub<StreamObject>,
  path: string
): Promise<number> {
  const response = await stub.fetch(`http://do${path}`, { method: `HEAD` })
  return response.status
}

describe(`fork edge idempotency`, () => {
  it(`counts a retried acquire exactly once`, async () => {
    const path = `/streams/edge-acquire-retry`
    const src = await createSource(path)

    // The same acquire applied twice — a retry after a lost response.
    const first = await src.forkAcquire({
      edgeId: `edge-a`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(first.ok).toBe(true)
    const second = await src.forkAcquire({
      edgeId: `edge-a`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    // The retry returns the recorded outcome, not a re-resolved one.
    expect(second.forkOffset).toBe(first.forkOffset)
    expect(second.sourceGeneration).toBe(first.sourceGeneration)

    // Delete soft-deletes (one reference outstanding)...
    const deleted = await src.fetch(`http://do${path}`, { method: `DELETE` })
    expect(deleted.status).toBe(204)
    expect(await statusOf(src, path)).toBe(410)

    // ...and ONE release must purge it. A double-counted acquire would
    // leave the source pinned at 410 forever.
    await src.forkRelease({
      edgeId: `edge-a`,
      sourceGeneration: first.sourceGeneration,
    })
    expect(await statusOf(src, path)).toBe(404)
  })

  it(`ignores a retried release while another fork still depends on the source`, async () => {
    const path = `/streams/edge-release-retry`
    const src = await createSource(path)

    const a = await src.forkAcquire({
      edgeId: `edge-a`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    const b = await src.forkAcquire({
      edgeId: `edge-b`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    const deleted = await src.fetch(`http://do${path}`, { method: `DELETE` })
    expect(deleted.status).toBe(204)

    // Release edge-a twice — a retry after a lost response. The second
    // call must be a no-op: it must NOT consume edge-b's reference.
    await src.forkRelease({
      edgeId: `edge-a`,
      sourceGeneration: a.sourceGeneration,
    })
    await src.forkRelease({
      edgeId: `edge-a`,
      sourceGeneration: a.sourceGeneration,
    })
    expect(await statusOf(src, path)).toBe(410)

    // Releasing the real remaining edge purges the source.
    await src.forkRelease({
      edgeId: `edge-b`,
      sourceGeneration: b.sourceGeneration,
    })
    expect(await statusOf(src, path)).toBe(404)
  })

  it(`ignores a delayed release from an earlier generation at the same path`, async () => {
    const path = `/streams/edge-generation-reuse`
    const src = await createSource(path)

    const oldEdge = await src.forkAcquire({
      edgeId: `edge-old`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(oldEdge.ok).toBe(true)
    if (!oldEdge.ok) return

    // Tear the first generation down completely, then recreate the path.
    await src.forkRelease({
      edgeId: `edge-old`,
      sourceGeneration: oldEdge.sourceGeneration,
    })
    const deleted = await src.fetch(`http://do${path}`, { method: `DELETE` })
    expect(deleted.status).toBe(204)
    await createSource(path)

    const newEdge = await src.forkAcquire({
      edgeId: `edge-new`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(newEdge.ok).toBe(true)
    if (!newEdge.ok) return
    expect(newEdge.sourceGeneration).not.toBe(oldEdge.sourceGeneration)

    // A delayed duplicate release from the OLD generation arrives now.
    // It must not consume the new generation's reference.
    await src.forkRelease({
      edgeId: `edge-old`,
      sourceGeneration: oldEdge.sourceGeneration,
    })

    const softDeleted = await src.fetch(`http://do${path}`, {
      method: `DELETE`,
    })
    expect(softDeleted.status).toBe(204)
    // Still referenced by edge-new: gone, not purged.
    expect(await statusOf(src, path)).toBe(410)

    await src.forkRelease({
      edgeId: `edge-new`,
      sourceGeneration: newEdge.sourceGeneration,
    })
    expect(await statusOf(src, path)).toBe(404)
  })

  it(`recovers from an acquire whose response was lost mid-create`, async () => {
    const srcPath = `/streams/edge-lost-response-src`
    const forkPath = `/streams/edge-lost-response-fork`
    const src = await createSource(srcPath)
    const fork = stubFor(forkPath)

    // Simulate the failure: a previous create attempt persisted its edge
    // intent, the acquire COMMITTED on the source, but the response (and
    // everything after it) was lost before the fork's meta was created.
    const edgeId = `edge-lost-response`
    const committed = await src.forkAcquire({
      edgeId,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(committed.ok).toBe(true)
    await runInDurableObject(fork, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO fork_intents (edge_id, parent_path, params_key) VALUES (?, ?, ?)`,
        edgeId,
        srcPath,
        JSON.stringify([srcPath, null])
      )
    })

    // The client retries the PUT. The create must reuse the durable
    // intent's edge id — acquiring a SECOND reference would pin the
    // source forever.
    const retried = await fork.fetch(`http://do${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": srcPath },
    })
    expect(retried.status).toBe(201)

    const deleted = await src.fetch(`http://do${srcPath}`, {
      method: `DELETE`,
    })
    expect(deleted.status).toBe(204)
    expect(await statusOf(src, srcPath)).toBe(410)

    const forkDeleted = await fork.fetch(`http://do${forkPath}`, {
      method: `DELETE`,
    })
    expect(forkDeleted.status).toBe(204)
    expect(await statusOf(src, srcPath)).toBe(404)
  })

  it(`reuses the durable edge intent when a fork create is retried`, async () => {
    const srcPath = `/streams/edge-intent-src`
    const forkPath = `/streams/edge-intent-fork`
    const src = await createSource(srcPath)
    const fork = stubFor(forkPath)

    // Two identical fork PUTs — the second is a client retry (e.g. the
    // first response was lost after commit). Idempotent create: 200/201,
    // and exactly ONE reference on the source.
    for (const _attempt of [1, 2]) {
      const response = await fork.fetch(`http://do${forkPath}`, {
        method: `PUT`,
        headers: { "Stream-Forked-From": srcPath },
      })
      expect([200, 201]).toContain(response.status)
    }

    const deleted = await src.fetch(`http://do${srcPath}`, {
      method: `DELETE`,
    })
    expect(deleted.status).toBe(204)
    expect(await statusOf(src, srcPath)).toBe(410)

    // Deleting the single fork must release the single reference and
    // cascade the source to purged.
    const forkDeleted = await fork.fetch(`http://do${forkPath}`, {
      method: `DELETE`,
    })
    expect(forkDeleted.status).toBe(204)
    expect(await statusOf(src, srcPath)).toBe(404)
  })
})

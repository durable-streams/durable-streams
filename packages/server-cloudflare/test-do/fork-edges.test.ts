/**
 * Regression tests for fork reference lifetime (direct DO access).
 *
 * Fork references cross Durable Object transaction boundaries: an RPC can
 * commit remotely while its response is lost, so the caller's retry MUST
 * be idempotent. References are therefore fork-edge rows with stable ids
 * (insert-if-absent / delete-if-present), qualified by the source
 * generation so a delayed release can never touch a recreated stream.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
  setStreamObjectTestHooks,
  suspendNextInheritedReadForTest,
} from "../src/stream-object"
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
        // Must match createFork's paramsKey format in src/stream-object.ts.
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

  it(`autonomously releases an acquire interrupted before local create commit`, async () => {
    const srcPath = `/streams/edge-interrupted-src`
    const forkPath = `/streams/edge-interrupted-fork`
    const src = await createSource(srcPath)
    const fork = stubFor(forkPath)

    await runInDurableObject(fork, (instance) => {
      setStreamObjectTestHooks(instance, {
        afterForkAcquire: () => Promise.reject(new Error(`interrupted`)),
      })
    })
    await expect(
      fork.fetch(`http://do${forkPath}`, {
        method: `PUT`,
        headers: { "Stream-Forked-From": srcPath },
      })
    ).rejects.toThrow(`interrupted`)
    await src.fetch(`http://do${srcPath}`, { method: `DELETE` })
    expect(await statusOf(src, srcPath)).toBe(410)

    // No PUT retry: the target's durable alarm reconciles the intent.
    await runInDurableObject(fork, (instance) => instance.alarm())
    expect(await statusOf(src, srcPath)).toBe(404)
  })

  it(`does not mix inherited data with a delete-recreated child generation`, async () => {
    const srcPath = `/streams/read-generation-src`
    const forkPath = `/streams/read-generation-fork`
    await createSource(srcPath)
    const fork = stubFor(forkPath)
    expect(
      (
        await fork.fetch(`http://do${forkPath}`, {
          method: `PUT`,
          headers: { "Stream-Forked-From": srcPath },
        })
      ).status
    ).toBe(201)

    let barrier!: ReturnType<typeof suspendNextInheritedReadForTest>
    await runInDurableObject(fork, (instance) => {
      barrier = suspendNextInheritedReadForTest(instance)
    })

    const reading = fork.fetch(`http://do${forkPath}`)
    while (!(await runInDurableObject(fork, () => barrier.entered()))) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(
      (await fork.fetch(`http://do${forkPath}`, { method: `DELETE` })).status
    ).toBe(204)
    expect(
      (
        await fork.fetch(`http://do${forkPath}`, {
          method: `PUT`,
          headers: { "Content-Type": `text/plain` },
          body: `G2`,
        })
      ).status
    ).toBe(201)
    await runInDurableObject(fork, () => barrier.resume())
    const response = await reading
    expect(await response.text()).toBe(`G2`)
  })

  it(`does not release the winner edge for simultaneous equivalent creates`, async () => {
    const srcPath = `/streams/edge-race-src`
    const forkPath = `/streams/edge-race-fork`
    const src = await createSource(srcPath)
    const fork = stubFor(forkPath)

    const make = () =>
      fork.fetch(`http://do${forkPath}`, {
        method: `PUT`,
        headers: { "Stream-Forked-From": srcPath },
      })
    const responses = await Promise.all([make(), make()])
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ])

    await src.fetch(`http://do${srcPath}`, { method: `DELETE` })
    expect((await fork.fetch(`http://do${forkPath}`)).status).toBe(200)
  })

  it(`never lets a simultaneous mismatched content type reuse an intent`, async () => {
    const srcPath = `/streams/edge-content-race-src`
    const forkPath = `/streams/edge-content-race-fork`
    await createSource(srcPath)
    const fork = stubFor(forkPath)
    const make = (contentType: string) =>
      fork.fetch(`http://do${forkPath}`, {
        method: `PUT`,
        headers: {
          "Stream-Forked-From": srcPath,
          "Content-Type": contentType,
        },
      })

    const responses = await Promise.all([
      make(`text/plain`),
      make(`application/json`),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ])
    const head = await fork.fetch(`http://do${forkPath}`, { method: `HEAD` })
    expect(head.headers.get(`content-type`)).toBe(`text/plain`)
  })

  it(`holds exactly one reference across sequential idempotent PUT retries`, async () => {
    const srcPath = `/streams/edge-intent-src`
    const forkPath = `/streams/edge-intent-fork`
    const src = await createSource(srcPath)
    const fork = stubFor(forkPath)

    // Two identical fork PUTs — the second is a client retry after the
    // first fully succeeded, so it takes the idempotent-match early
    // return. End to end: 200/201 both times, and exactly ONE reference
    // on the source. (The lost-response test above pins intent reuse.)
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

  it(`concurrent duplicate fork PUTs leave exactly one live reference`, async () => {
    const srcPath = `/streams/edge-concurrent-src`
    const forkPath = `/streams/edge-concurrent-fork`
    const src = await createSource(srcPath)
    const fork = stubFor(forkPath)

    // Two racing PUTs for the same not-yet-created fork. Interleaved
    // creations would share the durable edge intent — and the loser's
    // cleanup would release the edge the winner's meta owns, silently
    // orphaning the fork's inherited data.
    const [a, b] = await Promise.all([
      fork.fetch(`http://do${forkPath}`, {
        method: `PUT`,
        headers: { "Stream-Forked-From": srcPath },
      }),
      fork.fetch(`http://do${forkPath}`, {
        method: `PUT`,
        headers: { "Stream-Forked-From": srcPath },
      }),
    ])
    expect([200, 201]).toContain(a.status)
    expect([200, 201]).toContain(b.status)

    // The surviving fork's reference must still be counted: deleting the
    // source soft-deletes (410), it must NOT purge straight to 404.
    const deleted = await src.fetch(`http://do${srcPath}`, {
      method: `DELETE`,
    })
    expect(deleted.status).toBe(204)
    expect(await statusOf(src, srcPath)).toBe(410)

    // And the fork can still read its inherited data through the
    // soft-deleted source.
    const read = await fork.fetch(`http://do${forkPath}`)
    expect(read.status).toBe(200)
    expect(await read.text()).toBe(`source data`)

    const forkDeleted = await fork.fetch(`http://do${forkPath}`, {
      method: `DELETE`,
    })
    expect(forkDeleted.status).toBe(204)
    expect(await statusOf(src, srcPath)).toBe(404)
  })

  it(`delivers a queued release via the alarm`, async () => {
    const srcPath = `/streams/edge-gc-alarm-src`
    const forkPath = `/streams/edge-gc-alarm-fork`
    const src = await createSource(srcPath)
    const fork = stubFor(forkPath)

    // One outstanding edge; source soft-deleted behind it.
    const acquired = await src.forkAcquire({
      edgeId: `edge-gc-alarm`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const deleted = await src.fetch(`http://do${srcPath}`, {
      method: `DELETE`,
    })
    expect(deleted.status).toBe(204)
    expect(await statusOf(src, srcPath)).toBe(410)

    // Simulate a fork whose release RPC previously failed: the durable
    // gc_releases row exists and the retry alarm is armed. The alarm
    // must deliver the release and dequeue it.
    await runInDurableObject(fork, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO gc_releases (edge_id, parent_path, source_gen) VALUES (?, ?, ?)`,
        `edge-gc-alarm`,
        srcPath,
        acquired.sourceGeneration
      )
      // Far enough out that it cannot fire on its own before
      // runDurableObjectAlarm forces it.
      return state.storage.setAlarm(Date.now() + 60_000)
    })
    const ran = await runDurableObjectAlarm(fork)
    expect(ran).toBe(true)

    expect(await statusOf(src, srcPath)).toBe(404)
    const queued = await runInDurableObject(fork, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM gc_releases`)
        .toArray()
    )
    expect(queued[0]?.n).toBe(0)
  })

  it(`soft-deletes (not purges) an expired source that forks still reference`, async () => {
    const path = `/streams/edge-expired-referenced`
    const stub = stubFor(path)
    const created = await stub.fetch(`http://do${path}`, {
      method: `PUT`,
      headers: { "content-type": `text/plain`, "Stream-TTL": `60` },
      body: `inherited`,
    })
    expect(created.status).toBe(201)

    const acquired = await stub.forkAcquire({
      edgeId: `edge-expired`,
      forkOffset: undefined,
      contentTypeProvided: undefined,
    })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return

    // Push last access into the past so the sliding TTL has elapsed,
    // then fire the expiry alarm.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE meta SET last_accessed_at = ? WHERE id = 1`,
        Date.now() - 120_000
      )
    })
    const ran = await runDurableObjectAlarm(stub)
    expect(ran).toBe(true)

    // Referenced: the expiry must soft-delete, preserving inherited data.
    expect(await statusOf(stub, path)).toBe(410)

    await stub.forkRelease({
      edgeId: `edge-expired`,
      sourceGeneration: acquired.sourceGeneration,
    })
    expect(await statusOf(stub, path)).toBe(404)
  })
})

/**
 * Regression tests for the per-response read budget on forked streams.
 *
 * A stitched read crosses fork segments (inherited source data + the
 * fork's own data). The 4 MiB response budget must apply to the WHOLE
 * response: giving each segment a fresh budget lets response size scale
 * with fork depth, defeating the bound that protects structured-clone
 * and response-size limits.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { MAX_READ_BATCH_BYTES } from "../src/stream-object"
import type { StreamObject } from "../src/stream-object"

function stubFor(path: string): DurableObjectStub<StreamObject> {
  return env.STREAMS.get(env.STREAMS.idFromName(path))
}

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte)
}

describe(`fork read budget`, () => {
  it(`caps a stitched response at one budget across fork segments`, async () => {
    const srcPath = `/streams/budget-src`
    const forkPath = `/streams/budget-fork`
    const src = stubFor(srcPath)
    const fork = stubFor(forkPath)

    const created = await src.fetch(`http://do${srcPath}`, {
      method: `PUT`,
      headers: { "content-type": `application/octet-stream` },
    })
    expect(created.status).toBe(201)

    // 3,000,000 bytes of source data (two appends under the body limit).
    for (const byte of [1, 2]) {
      const appended = await src.fetch(`http://do${srcPath}`, {
        method: `POST`,
        headers: { "content-type": `application/octet-stream` },
        body: fill(byte, 1_500_000),
      })
      expect(appended.status).toBe(204)
    }

    // Fork at the source tail, then 1,500,000 bytes of fork-local data:
    // 4,500,000 bytes total across the fork boundary — over one budget.
    const forked = await fork.fetch(`http://do${forkPath}`, {
      method: `PUT`,
      headers: { "Stream-Forked-From": srcPath },
    })
    expect(forked.status).toBe(201)

    const forkAppend = await fork.fetch(`http://do${forkPath}`, {
      method: `POST`,
      headers: { "content-type": `application/octet-stream` },
      body: fill(3, 1_500_000),
    })
    expect(forkAppend.status).toBe(204)

    // Read the fork from the start: the response must not exceed the
    // single-response budget even though the data spans two segments.
    const first = await fork.fetch(`http://do${forkPath}`)
    expect(first.status).toBe(200)
    const firstBody = new Uint8Array(await first.arrayBuffer())
    expect(firstBody.byteLength).toBeLessThanOrEqual(MAX_READ_BATCH_BYTES)

    // A capped response advertises more data: no Stream-Up-To-Date yet.
    expect(first.headers.get(`Stream-Up-To-Date`)).toBeNull()

    // Continuation reads recover the remainder exactly once.
    const collected: Array<Uint8Array> = [firstBody]
    let offset = first.headers.get(`Stream-Next-Offset`)!
    expect(offset).toBeTruthy()
    let sawUpToDate = false
    for (let i = 0; i < 10; i++) {
      const next = await fork.fetch(
        `http://do${forkPath}?offset=${encodeURIComponent(offset)}`
      )
      expect(next.status).toBe(200)
      const body = new Uint8Array(await next.arrayBuffer())
      expect(body.byteLength).toBeLessThanOrEqual(MAX_READ_BATCH_BYTES)
      collected.push(body)
      offset = next.headers.get(`Stream-Next-Offset`)!
      if (next.headers.get(`Stream-Up-To-Date`) === `true`) {
        sawUpToDate = true
        break
      }
    }
    expect(sawUpToDate).toBe(true)

    const total = collected.reduce((sum, part) => sum + part.byteLength, 0)
    expect(total).toBe(4_500_000)

    // Byte-level integrity: 1.5MB of 1s, then 2s, then 3s — no
    // duplication or loss across the capped boundary.
    const combined = new Uint8Array(total)
    let pos = 0
    for (const part of collected) {
      combined.set(part, pos)
      pos += part.byteLength
    }
    expect(combined[0]).toBe(1)
    expect(combined[1_499_999]).toBe(1)
    expect(combined[1_500_000]).toBe(2)
    expect(combined[2_999_999]).toBe(2)
    expect(combined[3_000_000]).toBe(3)
    expect(combined[4_499_999]).toBe(3)
  })
})

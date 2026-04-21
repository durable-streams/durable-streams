/**
 * Tests for named checkpoint support.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { DurableStreamTestServer } from "../src/server"

const CHECKPOINT_RULES = [
  {
    name: `compact`,
    conditions: [
      { path: `.type`, value: `system` },
      { path: `.subtype`, value: `compact_boundary` },
    ],
  },
  {
    name: `user-turn`,
    conditions: [{ path: `.type`, value: `user` }],
  },
]

function createServer(options: { dataDir?: string } = {}) {
  return new DurableStreamTestServer({
    port: 0,
    longPollTimeout: 500,
    checkpointRules: CHECKPOINT_RULES,
    ...options,
  })
}

async function createJsonStream(
  baseUrl: string,
  streamPath: string
): Promise<void> {
  const res = await fetch(`${baseUrl}${streamPath}`, {
    method: `PUT`,
    headers: { "content-type": `application/json` },
  })
  expect(res.status).toBe(201)
}

async function appendJson(
  baseUrl: string,
  streamPath: string,
  data: unknown
): Promise<Response> {
  return fetch(`${baseUrl}${streamPath}`, {
    method: `POST`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(data),
  })
}

describe(`In-Memory Checkpoints`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = createServer()
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  test(`should create checkpoint on matching append`, async () => {
    const streamPath = `/v1/stream/cp-basic-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    // Append a non-matching message
    await appendJson(baseUrl, streamPath, { type: `user`, content: `hello` })

    // Append a matching compact_boundary message
    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    // Resolve checkpoint — should 307 redirect
    const res = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    expect(res.status).toBe(307)
    expect(res.headers.get(`cache-control`)).toBe(`no-store`)
    const location = res.headers.get(`location`)!
    expect(location).toContain(`offset=`)
    expect(location).not.toContain(`offset=compact`)
    expect(location).not.toContain(`offset=-1`)
  })

  test(`should update checkpoint to latest match (last-write-wins)`, async () => {
    const streamPath = `/v1/stream/cp-lww-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    // Append first matching message
    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    // Get the first checkpoint offset
    const res1 = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    const location1 = res1.headers.get(`location`)!

    // Append more data, then another matching message
    await appendJson(baseUrl, streamPath, { type: `data`, value: 1 })
    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    // Checkpoint should now point to the second match
    const res2 = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    const location2 = res2.headers.get(`location`)!
    expect(location2).not.toBe(location1)
  })

  test(`should redirect to -1 for unknown checkpoint`, async () => {
    const streamPath = `/v1/stream/cp-unknown-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    const res = await fetch(`${baseUrl}${streamPath}?offset=nonexistent`, {
      redirect: `manual`,
    })
    expect(res.status).toBe(307)
    expect(res.headers.get(`location`)).toContain(`offset=-1`)
  })

  test(`should preserve query params in redirect`, async () => {
    const streamPath = `/v1/stream/cp-params-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    const res = await fetch(`${baseUrl}${streamPath}?offset=compact&live=sse`, {
      redirect: `manual`,
    })
    expect(res.status).toBe(307)
    const location = res.headers.get(`location`)!
    expect(location).toContain(`live=sse`)
  })

  test(`should support multiple checkpoint rules independently`, async () => {
    const streamPath = `/v1/stream/cp-multi-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    // Trigger user-turn checkpoint
    await appendJson(baseUrl, streamPath, {
      type: `user`,
      content: `hello`,
    })

    // Trigger compact checkpoint
    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    // Both checkpoints should resolve
    const resUser = await fetch(`${baseUrl}${streamPath}?offset=user-turn`, {
      redirect: `manual`,
    })
    expect(resUser.status).toBe(307)
    expect(resUser.headers.get(`location`)).not.toContain(`offset=-1`)

    const resCompact = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    expect(resCompact.status).toBe(307)
    expect(resCompact.headers.get(`location`)).not.toContain(`offset=-1`)
  })

  test(`should not create checkpoint for partial match`, async () => {
    const streamPath = `/v1/stream/cp-partial-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    // type=system but no subtype — should not match compact rule
    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `something_else`,
    })

    const res = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    expect(res.status).toBe(307)
    expect(res.headers.get(`location`)).toContain(`offset=-1`)
  })

  test(`should work on closed streams`, async () => {
    const streamPath = `/v1/stream/cp-closed-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    // Close the stream
    await fetch(`${baseUrl}${streamPath}`, {
      method: `POST`,
      headers: { "stream-closed": `true` },
    })

    // Checkpoint should still resolve
    const res = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    expect(res.status).toBe(307)
    expect(res.headers.get(`location`)).not.toContain(`offset=-1`)
  })

  test(`should follow redirect and read data from checkpoint`, async () => {
    const streamPath = `/v1/stream/cp-read-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    // Append pre-compaction data
    await appendJson(baseUrl, streamPath, { type: `old`, value: 1 })
    await appendJson(baseUrl, streamPath, { type: `old`, value: 2 })

    // Compaction boundary
    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    // Post-compaction data
    await appendJson(baseUrl, streamPath, { type: `new`, value: 3 })

    // Follow the redirect and read
    const res = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `follow`,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Should get data from the checkpoint offset onwards (the post-compaction data)
    // The checkpoint points to the offset of the compact_boundary message,
    // so reading from that offset gives us data AFTER that message
    expect(body.length).toBe(1)
    expect(body[0]).toEqual({ type: `new`, value: 3 })
  })

  test(`should handle checkpoint on empty stream`, async () => {
    const streamPath = `/v1/stream/cp-empty-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    const res = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    expect(res.status).toBe(307)
    expect(res.headers.get(`location`)).toContain(`offset=-1`)
  })

  test(`sentinel offsets are not treated as checkpoints`, async () => {
    const streamPath = `/v1/stream/cp-sentinel-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    // -1 should work normally (not checkpoint lookup)
    const res1 = await fetch(`${baseUrl}${streamPath}?offset=-1`)
    expect(res1.status).toBe(200)

    // now should work normally (not checkpoint lookup)
    const res2 = await fetch(`${baseUrl}${streamPath}?offset=now`)
    expect(res2.status).toBe(200)
  })
})

describe(`File-Backed Checkpoints`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(tmpdir(), `checkpoint-test-`))
    server = createServer({ dataDir })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test(`should create and resolve checkpoint with file store`, async () => {
    const streamPath = `/v1/stream/cp-file-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })

    const res = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `manual`,
    })
    expect(res.status).toBe(307)
    expect(res.headers.get(`location`)).not.toContain(`offset=-1`)
  })

  test(`should follow redirect and read data from checkpoint`, async () => {
    const streamPath = `/v1/stream/cp-file-read-${Date.now()}`
    await createJsonStream(baseUrl, streamPath)

    await appendJson(baseUrl, streamPath, { type: `old`, value: 1 })
    await appendJson(baseUrl, streamPath, {
      type: `system`,
      subtype: `compact_boundary`,
    })
    await appendJson(baseUrl, streamPath, { type: `new`, value: 2 })

    const res = await fetch(`${baseUrl}${streamPath}?offset=compact`, {
      redirect: `follow`,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBe(1)
    expect(body[0]).toEqual({ type: `new`, value: 2 })
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  abortProxyStream,
  createProxyStream,
  readProxyStream,
} from "../harness/client.js"
import {
  createMockUpstream,
  createSSEChunks,
} from "../harness/mock-upstream.js"
import { getRuntime } from "../runtime.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

beforeAll(async () => {
  upstream = await createMockUpstream()
})

beforeEach(() => {
  upstream.reset()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: abort extended`, () => {
  it(`returns 401 when no authentication is provided`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      `some-stream-id`
    )
    url.searchParams.set(`action`, `abort`)
    const response = await fetch(url.toString(), { method: `PATCH` })
    expect(response.status).toBe(401)
  })

  it(`returns INVALID_ACTION when PATCH action is missing`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      `some-stream-id-${Date.now()}`
    )
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(url, headers)
    const response = await fetch(url.toString(), { method: `PATCH`, headers })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe(`INVALID_ACTION`)
  })

  it(`returns INVALID_ACTION for PATCH action=connect`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      `some-stream-id-${Date.now()}`
    )
    url.searchParams.set(`action`, `connect`)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(url, headers)
    const response = await fetch(url.toString(), { method: `PATCH`, headers })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe(`INVALID_ACTION`)
  })

  it(`returns 204 for already completed streams`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: `data: done\n\n`,
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const response = await abortProxyStream({ streamUrl: created.streamUrl! })
    expect(response.status).toBe(204)
  })

  it(`preserves data written before abort`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"chunk": 1}` },
        { data: `{"chunk": 2}` },
        ...Array.from({ length: 20 }, (_, i) => ({
          data: `{"chunk": ${i + 3}}`,
        })),
      ]),
      chunkDelayMs: 50,
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const aborted = await abortProxyStream({ streamUrl: created.streamUrl! })
    expect(aborted.status).toBe(204)
    const read = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    expect(read.status).toBe(200)
    expect(await read.text()).toContain(`"chunk": 1`)
  })
})

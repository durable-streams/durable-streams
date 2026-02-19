import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createProxyStream,
  deleteProxyStream,
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

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: delete extended`, () => {
  it(`returns 401 when secret is missing`, async () => {
    const runtime = getRuntime()
    const response = await fetch(
      runtime.adapter
        .streamUrl(runtime.getBaseUrl(), `some-stream-id`)
        .toString(),
      { method: `DELETE` }
    )
    expect(response.status).toBe(401)
  })

  it(`returns 401 when secret is invalid`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      `some-stream-id`
    )
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(url, headers)
    if (url.searchParams.has(`secret`)) {
      url.searchParams.set(`secret`, `wrong-secret`)
    }
    const response = await fetch(url.toString(), { method: `DELETE`, headers })
    expect(response.status).toBe(401)
  })

  it(`is idempotent for non-existent stream`, async () => {
    const response = await deleteProxyStream(
      `00000000-0000-0000-0000-000000000000`
    )
    expect(response.status).toBe(204)
  })

  it(`aborts in-flight upstream when deleting`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array.from({ length: 100 }, (_, i) => ({ data: `chunk ${i}` }))
      ),
      chunkDelayMs: 100,
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.streamId).toBeTruthy()
    const deleted = await deleteProxyStream(created.streamId!)
    expect(deleted.status).toBe(204)
    const read = await readProxyStream({ streamUrl: created.streamUrl! })
    expect([404, 410]).toContain(read.status)
  })
})

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connectProxyStream, createProxyStream } from "../harness/client.js"
import {
  createAIStreamingResponse,
  createMockUpstream,
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

describe(`proxy conformance: pre-signed URL freshness`, () => {
  it(`returns fresh Location URLs on create, append, and connect`, async () => {
    upstream.setResponse(createAIStreamingResponse([`create`], 10))
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.status).toBe(201)
    expect(created.streamUrl).toBeTruthy()

    await new Promise((resolve) => setTimeout(resolve, 1100))
    upstream.setResponse(createAIStreamingResponse([`append`], 10))
    const appended = await createProxyStream({
      streamId: created.streamId!,
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(appended.status).toBe(200)
    expect(appended.streamUrl).toBeTruthy()
    expect(appended.streamUrl).not.toBe(created.streamUrl)

    if (!getRuntime().capabilities.connect) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 1100))
    const connected = await connectProxyStream({
      streamId: created.streamId!,
      upstreamUrl: upstream.url + `/v1/connect`,
    })
    expect([200, 201]).toContain(connected.status)
    const connectLocation = connected.headers.get(`Location`)
    expect(connectLocation).toBeTruthy()
    const normalizedConnectLocation = new URL(
      connectLocation!,
      getRuntime().getBaseUrl()
    ).toString()
    expect(normalizedConnectLocation).not.toBe(created.streamUrl)
    expect(normalizedConnectLocation).not.toBe(appended.streamUrl)
  })
})

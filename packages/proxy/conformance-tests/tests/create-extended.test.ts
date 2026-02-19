import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
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

beforeEach(() => {
  upstream.reset()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: create extended`, () => {
  it(`returns 400 when Upstream-URL is missing`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.createUrl(runtime.getBaseUrl())
    const headers = new Headers({
      "Upstream-Method": `POST`,
      "Content-Type": `application/json`,
    })
    await runtime.adapter.applyServiceAuth(url, headers)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })

  it(`returns 400 when Upstream-Method is missing`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.createUrl(runtime.getBaseUrl())
    const headers = new Headers({
      "Upstream-URL": upstream.url + `/v1/chat`,
      "Content-Type": `application/json`,
    })
    await runtime.adapter.applyServiceAuth(url, headers)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_METHOD`)
  })

  it(`returns Upstream-Content-Type and Stream-Response-Id on success`, async () => {
    upstream.setResponse(createAIStreamingResponse([`Response`]))
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(201)
    expect(result.headers.get(`Upstream-Content-Type`)).toContain(
      `text/event-stream`
    )
    expect(result.headers.get(`Stream-Response-Id`)).toBe(`1`)
  })

  it(`blocks upstream 302 redirects`, async () => {
    upstream.setResponse({
      status: 302,
      headers: { Location: `http://169.254.169.254/latest/meta-data/` },
      body: ``,
    })
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `REDIRECT_NOT_ALLOWED`
    )
  })

  it(`blocks upstream 307 redirects`, async () => {
    upstream.setResponse({
      status: 307,
      headers: { Location: `http://internal.service/admin` },
      body: ``,
    })
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `REDIRECT_NOT_ALLOWED`
    )
  })
})

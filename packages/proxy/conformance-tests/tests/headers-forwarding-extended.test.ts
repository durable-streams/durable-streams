import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
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

describe(`proxy conformance: headers forwarding extended`, () => {
  it(`forwards Upstream-Authorization as Authorization`, async () => {
    upstream.setResponse({ status: 200, body: `ok` })
    await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
      headers: { Authorization: `Bearer sk-test-token-12345` },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const lastRequest = upstream.getLastRequest()
    expect(lastRequest?.headers[`authorization`]).toBe(
      `Bearer sk-test-token-12345`
    )
  })

  it(`does not forward proxy Authorization when Upstream-Authorization is present`, async () => {
    upstream.setResponse({ status: 200, body: `ok` })
    await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
      headers: {
        Authorization: `Bearer proxy-auth-token`,
        "Upstream-Authorization": `Bearer upstream-auth-token`,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const lastRequest = upstream.getLastRequest()
    expect(lastRequest?.headers[`authorization`]).toBe(
      `Bearer upstream-auth-token`
    )
  })

  it(`forwards content type and custom headers`, async () => {
    upstream.setResponse({ status: 200, body: `ok` })
    await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: { test: true },
      headers: {
        "Content-Type": `application/json`,
        "X-Custom-Header": `custom-value`,
        "X-Request-Id": `req-12345`,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const lastRequest = upstream.getLastRequest()
    expect(lastRequest?.headers[`content-type`]).toBe(`application/json`)
    expect(lastRequest?.headers[`x-custom-header`]).toBe(`custom-value`)
    expect(lastRequest?.headers[`x-request-id`]).toBe(`req-12345`)
  })

  it(`forwards request body upstream`, async () => {
    upstream.setResponse({ status: 200, body: `ok` })
    const requestBody = {
      model: `gpt-4`,
      messages: [{ role: `user`, content: `Hello` }],
      stream: true,
    }
    await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: requestBody,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const lastRequest = upstream.getLastRequest()
    const receivedBody = JSON.parse(lastRequest?.body ?? `{}`)
    expect(receivedBody.model).toBe(`gpt-4`)
    expect(receivedBody.messages).toHaveLength(1)
    expect(receivedBody.stream).toBe(true)
  })

  it(`returns CORS headers on error responses`, async () => {
    const runtime = getRuntime()
    const response = await fetch(
      runtime.adapter.createUrl(runtime.getBaseUrl()).toString(),
      {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{}`,
      }
    )
    expect(response.status).toBe(401)
    expect(response.headers.get(`access-control-allow-origin`)).toBe(`*`)
  })
})

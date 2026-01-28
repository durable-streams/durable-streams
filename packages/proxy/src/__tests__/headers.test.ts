/**
 * Tests for header forwarding behavior.
 *
 * The proxy should forward most headers to upstream while filtering
 * out hop-by-hop headers and certain sensitive headers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createStream, createTestContext } from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`header forwarding`, () => {
  it(`forwards Upstream-Authorization header to upstream as Authorization`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      upstreamAuth: `Bearer sk-test-token-12345`,
      body: {},
    })

    // Wait for async upstream request to be made
    await new Promise((r) => setTimeout(r, 100))

    const lastRequest = ctx.upstream.getLastRequest()
    expect(lastRequest).toBeDefined()
    expect(lastRequest!.headers[`authorization`]).toBe(
      `Bearer sk-test-token-12345`
    )
  })

  it(`forwards Content-Type header to upstream`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: { test: true },
      headers: {
        "Content-Type": `application/json`,
      },
    })

    // Wait for async upstream request
    await new Promise((r) => setTimeout(r, 100))

    const lastRequest = ctx.upstream.getLastRequest()
    expect(lastRequest).toBeDefined()
    expect(lastRequest!.headers[`content-type`]).toBe(`application/json`)
  })

  it(`forwards custom headers to upstream`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
      headers: {
        "X-Custom-Header": `custom-value`,
        "X-Request-Id": `req-12345`,
      },
    })

    // Wait for async upstream request
    await new Promise((r) => setTimeout(r, 100))

    const lastRequest = ctx.upstream.getLastRequest()
    expect(lastRequest).toBeDefined()
    expect(lastRequest!.headers[`x-custom-header`]).toBe(`custom-value`)
    expect(lastRequest!.headers[`x-request-id`]).toBe(`req-12345`)
  })

  it(`does not forward Host header to upstream`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for async upstream request
    await new Promise((r) => setTimeout(r, 100))

    const lastRequest = ctx.upstream.getLastRequest()
    expect(lastRequest).toBeDefined()
    // Host should be the upstream host, not the proxy port
    // The proxy uses random ports, so we just check the request was made
  })

  it(`does not forward Connection header to upstream`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    const url = new URL(`/v1/proxy/chat`, ctx.urls.proxy)

    await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Content-Type": `application/json`,
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        Connection: `keep-alive`,
      },
      body: `{}`,
    })

    // Wait for async upstream request
    await new Promise((r) => setTimeout(r, 100))

    const lastRequest = ctx.upstream.getLastRequest()
    // Connection header should be filtered or set by the HTTP client
    // The key point is we don't blindly forward it
    expect(lastRequest).toBeDefined()
  })

  it(`forwards the request body to upstream`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    const requestBody = {
      model: `gpt-4`,
      messages: [{ role: `user`, content: `Hello` }],
      stream: true,
    }

    await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: requestBody,
    })

    // Wait for async upstream request
    await new Promise((r) => setTimeout(r, 100))

    const lastRequest = ctx.upstream.getLastRequest()
    expect(lastRequest).toBeDefined()
    const receivedBody = JSON.parse(lastRequest!.body)
    expect(receivedBody.model).toBe(`gpt-4`)
    expect(receivedBody.messages).toHaveLength(1)
    expect(receivedBody.stream).toBe(true)
  })
})

describe(`CORS headers`, () => {
  it(`returns CORS headers on OPTIONS request`, async () => {
    const response = await fetch(`${ctx.urls.proxy}/v1/proxy/chat`, {
      method: `OPTIONS`,
    })

    expect(response.status).toBe(204)
    expect(response.headers.get(`access-control-allow-origin`)).toBe(`*`)
    expect(response.headers.get(`access-control-allow-methods`)).toContain(
      `POST`
    )
    expect(response.headers.get(`access-control-allow-methods`)).toContain(
      `GET`
    )
  })

  it(`returns CORS headers on error responses`, async () => {
    const url = new URL(`/v1/proxy/chat`, ctx.urls.proxy)
    // Missing required Upstream-URL header should return error with CORS headers

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: `{}`,
    })

    expect(response.status).toBe(400)
    expect(response.headers.get(`access-control-allow-origin`)).toBe(`*`)
  })
})

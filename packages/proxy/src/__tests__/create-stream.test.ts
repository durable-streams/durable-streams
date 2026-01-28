/**
 * Tests for stream creation through the proxy.
 *
 * POST /v1/proxy/{service}
 * Headers: Upstream-URL, Upstream-Method, Upstream-Authorization
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
  readStream,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream creation`, () => {
  it(`returns 201 with Location header containing pre-signed URL on success`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`, ` World`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [{ role: `user`, content: `Hello` }] },
    })

    expect(result.status).toBe(201)
    expect(result.location).toBeDefined()
    expect(result.streamId).toBeDefined()
    // Verify stream ID is UUIDv7 format
    expect(result.streamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(result.expires).toBeDefined()
    expect(result.signature).toBeDefined()
    expect(result.upstreamContentType).toBeDefined()
  })

  it(`returns 400 when Upstream-URL header is missing`, async () => {
    const url = new URL(`/v1/proxy/chat`, ctx.urls.proxy)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })

  it(`returns 403 when upstream is not in allowlist`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: `https://evil.example.com/api`,
      body: {},
    })

    expect(result.status).toBe(403)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `UPSTREAM_NOT_ALLOWED`
    )
  })

  it(`allows upstream URLs matching allowlist patterns`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `OK` })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/api/chat`,
      body: {},
    })

    // Should succeed (not 403)
    expect(result.status).not.toBe(403)
  })

  it(`returns 201 and includes Upstream-Content-Type header`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Response`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(result.status).toBe(201)
    expect(result.upstreamContentType).toBe(`text/event-stream`)
  })

  it(`returns 502 when upstream returns error`, async () => {
    ctx.upstream.setResponse({
      status: 500,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Internal server error` }),
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(result.status).toBe(502)
    expect(result.headers.get(`Upstream-Status`)).toBe(`500`)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `UPSTREAM_ERROR`
    )
  })

  it(`forwards Upstream-Authorization to upstream as Authorization`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      upstreamAuth: `Bearer sk-test-key`,
      body: {},
    })

    const lastRequest = ctx.upstream.getLastRequest()
    expect(lastRequest).toBeDefined()
    expect(lastRequest!.headers[`authorization`]).toBe(`Bearer sk-test-key`)
  })

  it(`uses Upstream-Method for the upstream request`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      upstreamMethod: `PUT`,
      body: {},
    })

    const lastRequest = ctx.upstream.getLastRequest()
    expect(lastRequest).toBeDefined()
    expect(lastRequest!.method).toBe(`PUT`)
  })
})

describe(`stream reading with pre-signed URL`, () => {
  it(`can read stream data using the pre-signed URL from Location`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`, ` World`]))

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(createResult.status).toBe(201)
    expect(createResult.streamId).toBeDefined()
    expect(createResult.expires).toBeDefined()
    expect(createResult.signature).toBeDefined()

    // Wait for some data to be written
    await new Promise((r) => setTimeout(r, 100))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toContain(`Hello`)
  })
})

describe(`security: SSRF redirect prevention`, () => {
  it(`blocks upstream 302 redirects with 400 error`, async () => {
    ctx.upstream.setResponse({
      status: 302,
      headers: {
        Location: `http://169.254.169.254/latest/meta-data/`,
      },
      body: ``,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // RFC v1.1: Redirects now return 400 directly
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `REDIRECT_NOT_ALLOWED`
    )
  })

  it(`blocks upstream 307 redirects with 400 error`, async () => {
    ctx.upstream.setResponse({
      status: 307,
      headers: {
        Location: `http://internal.service/admin`,
      },
      body: ``,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `REDIRECT_NOT_ALLOWED`
    )
  })
})

describe(`security: pre-signed URL validation`, () => {
  it(`rejects read request with invalid signature`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Try to read with tampered signature
    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: `tampered-signature`,
      offset: `-1`,
    })

    expect(readResult.status).toBe(401)
  })

  it(`rejects read request with expired URL`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Try to read with past expiration
    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: `1000000000`, // Year 2001
      signature: createResult.signature!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(401)
  })
})

/**
 * Tests for stream creation through the proxy.
 *
 * POST /v1/proxy/{service}?stream_key=...&upstream=...
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream creation`, () => {
  it(`returns 201 with path and token headers on success`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`, ` World`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `test-key-1`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [{ role: `user`, content: `Hello` }] },
    })

    expect(result.status).toBe(201)
    expect(result.streamPath).toBeDefined()
    expect(result.streamPath).toContain(`chat`)
    expect(result.streamPath).toContain(`test-key-1`)
    expect(result.readToken).toBeDefined()
    expect(result.readToken!.split(`.`)).toHaveLength(3) // JWT format
  })

  it(`returns 400 when stream_key is missing`, async () => {
    const url = new URL(`/v1/proxy/chat`, ctx.urls.proxy)
    url.searchParams.set(`upstream`, ctx.urls.upstream + `/v1/chat`)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_STREAM_KEY`)
  })

  it(`returns 400 when upstream is missing`, async () => {
    const url = new URL(`/v1/proxy/chat`, ctx.urls.proxy)
    url.searchParams.set(`stream_key`, `some-key`)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM`)
  })

  it(`returns 400 when upstream URL is invalid`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `test-invalid-url`,
      upstreamUrl: `not-a-valid-url`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `INVALID_UPSTREAM`
    )
  })

  it(`returns 403 when upstream is not in allowlist`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `test-not-allowed`,
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
      streamKey: `test-allowed`,
      upstreamUrl: ctx.urls.upstream + `/api/chat`,
      body: {},
    })

    // Should succeed (not 403)
    expect(result.status).not.toBe(403)
  })

  it(`handles duplicate stream key gracefully`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const streamKey = `duplicate-key-${Date.now()}`

    // Create first stream
    const firstResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })
    expect(firstResult.status).toBe(201)

    // Wait for first stream to be created
    await new Promise((r) => setTimeout(r, 50))

    // Try to create duplicate - durable streams PUT is idempotent,
    // so with same config we get 200 OK (stream exists), which proxy treats as conflict
    ctx.upstream.setResponse(createAIStreamingResponse([`Test2`]))
    const secondResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    // The durable streams server returns 200 for idempotent PUT
    // Our proxy should detect this and return 409
    expect(secondResult.status).toBe(409)
    expect((secondResult.body as { error: { code: string } }).error.code).toBe(
      `STREAM_EXISTS`
    )
  })

  it(`includes response body as JSON with path and token`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Response`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `test-body-response`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(result.status).toBe(201)
    const body = result.body as { path: string; readToken: string }
    expect(body.path).toBe(result.streamPath)
    expect(body.readToken).toBe(result.readToken)
  })
})

describe(`security: path traversal prevention`, () => {
  it(`rejects stream_key containing ..`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `../../../etc/passwd`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `INVALID_STREAM_KEY`
    )
  })

  it(`rejects stream_key containing forward slash`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `foo/bar/baz`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `INVALID_STREAM_KEY`
    )
  })

  it(`rejects stream_key with URL-encoded path traversal`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `%2e%2e%2f%2e%2e%2fadmin`, // URL-encoded ../..
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `INVALID_STREAM_KEY`
    )
  })

  it(`rejects stream_key containing backslash`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `foo\\bar`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `INVALID_STREAM_KEY`
    )
  })
})

describe(`security: SSRF redirect prevention`, () => {
  it(`blocks upstream 302 redirects`, async () => {
    ctx.upstream.setResponse({
      status: 302,
      headers: {
        Location: `http://169.254.169.254/latest/meta-data/`,
      },
      body: ``,
    })

    const streamKey = `ssrf-redirect-test-${Date.now()}`
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Stream creation succeeds (201) but the upstream connection should fail
    // The control message in the stream should indicate the error
    expect(result.status).toBe(201)

    // Wait for the stream to be written with error
    await new Promise((r) => setTimeout(r, 100))

    // Read the stream to verify the error control message
    const readUrl = new URL(
      `/v1/proxy/chat/streams/${streamKey}`,
      ctx.urls.proxy
    )
    readUrl.searchParams.set(`offset`, `-1`)

    const readResponse = await fetch(readUrl.toString(), {
      headers: {
        Authorization: `Bearer ${result.readToken}`,
      },
    })

    const content = await readResponse.text()
    expect(content).toContain(`REDIRECT_NOT_ALLOWED`)
  })

  it(`blocks upstream 307 redirects`, async () => {
    ctx.upstream.setResponse({
      status: 307,
      headers: {
        Location: `http://internal.service/admin`,
      },
      body: ``,
    })

    const streamKey = `ssrf-307-test-${Date.now()}`
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(201)

    await new Promise((r) => setTimeout(r, 100))

    const readUrl = new URL(
      `/v1/proxy/chat/streams/${streamKey}`,
      ctx.urls.proxy
    )
    readUrl.searchParams.set(`offset`, `-1`)

    const readResponse = await fetch(readUrl.toString(), {
      headers: {
        Authorization: `Bearer ${result.readToken}`,
      },
    })

    const content = await readResponse.text()
    expect(content).toContain(`REDIRECT_NOT_ALLOWED`)
  })
})

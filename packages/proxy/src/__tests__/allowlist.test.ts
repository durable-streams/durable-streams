/**
 * Tests for upstream URL allowlist validation.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createStream, createTestContext } from "./harness"

const ctx = createTestContext({
  // Configure specific allowlist for testing
  allowlist: [
    `http://localhost:*/**`,
    `https://api.openai.com/**`,
    `https://api.anthropic.com/v1/*`,
    `https://*.example.com/api/**`,
  ],
})

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`allowlist validation`, () => {
  it(`allows exact match URLs`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `allowlist-exact-${Date.now()}`,
      upstreamUrl: ctx.urls.upstream + `/api/test`,
      body: {},
    })

    // Should be allowed (matches http://localhost:*/**)
    expect(result.status).not.toBe(403)
  })

  it(`allows URLs matching wildcard patterns`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `allowlist-wildcard-${Date.now()}`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(result.status).not.toBe(403)
  })

  it(`blocks URLs not in allowlist`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `allowlist-blocked-${Date.now()}`,
      upstreamUrl: `https://evil.hacker.com/steal-data`,
      body: {},
    })

    expect(result.status).toBe(403)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `UPSTREAM_NOT_ALLOWED`
    )
  })

  it(`blocks URLs with similar but non-matching domains`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `allowlist-similar-${Date.now()}`,
      upstreamUrl: `https://api.openai.com.evil.com/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(403)
  })

  it(`validates URL format before allowlist check`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `allowlist-invalid-${Date.now()}`,
      upstreamUrl: `not-a-valid-url`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `INVALID_UPSTREAM`
    )
  })

  it(`blocks URLs with different schemes`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `allowlist-scheme-${Date.now()}`,
      upstreamUrl: `ftp://api.openai.com/v1/chat`,
      body: {},
    })

    // FTP is not a valid scheme
    expect(result.status).toBe(400)
  })
})

describe(`allowlist pattern matching`, () => {
  it(`** matches any path depth`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `pattern-depth-${Date.now()}`,
      upstreamUrl: ctx.urls.upstream + `/v1/a/b/c/d/e/f/g`,
      body: {},
    })

    expect(result.status).not.toBe(403)
  })

  it(`* matches single path segment`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    // Should match https://api.anthropic.com/v1/*
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `pattern-single-${Date.now()}`,
      upstreamUrl: `https://api.anthropic.com/v1/messages`,
      body: {},
    })

    // This should match - single segment after /v1/
    expect(result.status).not.toBe(403)
  })

  it(`port wildcards work correctly`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `ok` })

    // Should match http://localhost:*/**
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `pattern-port-${Date.now()}`,
      upstreamUrl: `http://localhost:9999/any/path`,
      body: {},
    })

    expect(result.status).not.toBe(403)
  })
})

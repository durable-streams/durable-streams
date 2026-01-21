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

  it(`subdomain wildcards match correctly`, async () => {
    // Should match https://*.example.com/api/**
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `pattern-subdomain-${Date.now()}`,
      upstreamUrl: `https://sub.example.com/api/v1/test`,
      body: {},
    })

    // Should be allowed - subdomain matches *.example.com
    expect(result.status).not.toBe(403)
  })

  it(`subdomain wildcards don't match bare domain`, async () => {
    // *.example.com should NOT match example.com (no subdomain)
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `pattern-no-subdomain-${Date.now()}`,
      upstreamUrl: `https://example.com/api/v1/test`,
      body: {},
    })

    // Should be blocked - no subdomain present
    expect(result.status).toBe(403)
  })
})

describe(`security: URL normalization`, () => {
  it(`normalizes default HTTPS port (443)`, async () => {
    // https://api.openai.com:443/** should match https://api.openai.com/**
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `norm-port-443-${Date.now()}`,
      upstreamUrl: `https://api.openai.com:443/v1/chat`,
      body: {},
    })

    // Should be allowed - :443 is default for HTTPS
    expect(result.status).not.toBe(403)
  })

  it(`normalizes hostname case`, async () => {
    // HTTPS://API.OPENAI.COM/** should match https://api.openai.com/**
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `norm-case-${Date.now()}`,
      upstreamUrl: `https://API.OPENAI.COM/v1/chat`,
      body: {},
    })

    // Should be allowed - hostname is case-insensitive
    expect(result.status).not.toBe(403)
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
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

describe(`proxy conformance: allowlist extended`, () => {
  it(`blocks similar but non-matching domains`, async () => {
    const result = await createProxyStream({
      upstreamUrl: `https://api.openai.com.evil.com/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(403)
  })

  it(`rejects invalid URL format before allowlist check`, async () => {
    const result = await createProxyStream({
      upstreamUrl: `not-a-valid-url`,
      body: {},
    })
    expect(result.status).toBe(403)
  })

  it(`rejects non-http schemes`, async () => {
    const result = await createProxyStream({
      upstreamUrl: `ftp://api.openai.com/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(403)
  })

  it(`allows localhost wildcard patterns used for mock upstream`, async () => {
    upstream.setResponse({ status: 200, body: `ok` })
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/allowlist-ok`,
      body: {},
    })
    expect(result.status).not.toBe(403)
  })
})

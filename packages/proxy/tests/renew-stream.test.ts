/**
 * Legacy Renew-Stream-URL behavior tests.
 *
 * Renew-Stream-URL is not part of URL-based dispatch and is ignored.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAIStreamingResponse, createTestContext } from "./harness"

const ctx = createTestContext()
const TEST_SECRET = `test-secret-key-for-development`

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`legacy Renew-Stream-URL header`, () => {
  it(`does not trigger a dedicated renew operation`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`hello`]))

    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)
    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        "Upstream-Method": `POST`,
        "Renew-Stream-URL": `https://example.com/legacy`,
      },
      body: JSON.stringify({}),
    })

    expect([200, 201]).toContain(response.status)
    expect(response.headers.get(`Location`)).toBeDefined()
  })

  it(`still requires create headers even when Renew-Stream-URL is set`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)
    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Renew-Stream-URL": `https://example.com/legacy`,
      },
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })
})

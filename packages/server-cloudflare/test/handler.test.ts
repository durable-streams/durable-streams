/**
 * Unit tests for createStreamsHandler's response post-processing: CORS
 * stripping with `cors: false` and cache-control downgrading when an auth
 * gate is active. The Durable Object is stubbed; these behaviors live
 * entirely in the Worker-side handler.
 */

import { describe, expect, test } from "vitest"
import { createStreamsHandler } from "../src/handler"
import type { StreamsEnv } from "../src/stream-object"

/** Headers the DO's respond() sets unconditionally on every response. */
const DO_RESPONSE_HEADERS: Record<string, string> = {
  "content-type": `text/plain`,
  "access-control-allow-origin": `*`,
  "access-control-allow-methods": `GET, POST, PUT, DELETE, HEAD, OPTIONS`,
  "access-control-allow-headers": `content-type, authorization, If-None-Match`,
  "access-control-expose-headers": `Stream-Next-Offset, Stream-Closed`,
  "x-content-type-options": `nosniff`,
  "cross-origin-resource-policy": `cross-origin`,
}

/** Env whose STREAMS stub always returns the given response headers. */
function stubEnv(
  extraHeaders: Record<string, string> = {},
  env: Record<string, string> = {}
): StreamsEnv {
  return {
    ...env,
    STREAMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () =>
          Promise.resolve(
            new Response(`data`, {
              status: 200,
              headers: { ...DO_RESPONSE_HEADERS, ...extraHeaders },
            })
          ),
      }),
    },
  }
}

const request = (init: RequestInit = {}): Request =>
  new Request(`http://example.com/streams/test`, init)

describe(`createStreamsHandler`, () => {
  describe(`cors: false`, () => {
    test(`strips CORS headers from forwarded stream responses`, async () => {
      const handler = createStreamsHandler({ cors: false })
      const response = await handler(request(), stubEnv())

      expect(response.status).toBe(200)
      expect(response.headers.get(`access-control-allow-origin`)).toBeNull()
      expect(response.headers.get(`access-control-allow-methods`)).toBeNull()
      expect(response.headers.get(`access-control-allow-headers`)).toBeNull()
      expect(response.headers.get(`access-control-expose-headers`)).toBeNull()
      // Non-CORS headers pass through untouched.
      expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
      expect(await response.text()).toBe(`data`)
    })

    test(`keeps CORS headers by default`, async () => {
      const handler = createStreamsHandler()
      const response = await handler(request(), stubEnv())

      expect(response.headers.get(`access-control-allow-origin`)).toBe(`*`)
    })
  })

  describe(`authenticated caching`, () => {
    const publicCache = {
      "cache-control": `public, max-age=60, stale-while-revalidate=300`,
    }

    test(`downgrades public cache-control to no-store with a custom auth hook`, async () => {
      const handler = createStreamsHandler({ auth: () => undefined })
      const response = await handler(request(), stubEnv(publicCache))

      expect(response.headers.get(`cache-control`)).toBe(`no-store`)
      expect(await response.text()).toBe(`data`)
    })

    test(`downgrades public cache-control to no-store when AUTH_TOKEN is set`, async () => {
      const handler = createStreamsHandler()
      const response = await handler(
        request({ headers: { authorization: `Bearer secret` } }),
        stubEnv(publicCache, { AUTH_TOKEN: `secret` })
      )

      expect(response.headers.get(`cache-control`)).toBe(`no-store`)
    })

    test(`keeps public cache-control when no auth gate is active`, async () => {
      const handler = createStreamsHandler()
      const response = await handler(request(), stubEnv(publicCache))

      expect(response.headers.get(`cache-control`)).toBe(
        `public, max-age=60, stale-while-revalidate=300`
      )
    })

    test(`leaves non-public cache-control alone when authenticated`, async () => {
      const handler = createStreamsHandler({ auth: () => undefined })
      const response = await handler(
        request(),
        stubEnv({ "cache-control": `no-cache` })
      )

      expect(response.headers.get(`cache-control`)).toBe(`no-cache`)
    })
  })
})

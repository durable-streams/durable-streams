/**
 * Tests for backend configuration options (streamPath and backendHeaders).
 *
 * Verifies that the proxy correctly applies custom URL paths and headers
 * when communicating with the durable-streams backend.
 */

import { createServer } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createProxyServer } from "../server"
import { createAIStreamingResponse, createMockUpstream } from "./harness"
import type { MockUpstreamServer } from "./harness"
import type { ProxyServer } from "../server"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

/**
 * A recording backend that captures all requests and proxies them
 * to a real durable-streams server (or returns canned responses).
 */
interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
}

interface RecordingBackend {
  url: string
  requests: Array<RecordedRequest>
  stop: () => Promise<void>
  clear: () => void
}

/**
 * Create a backend that records requests, then proxies them to the real
 * durable-streams server so the full flow works end-to-end.
 */
async function createRecordingBackend(
  realBackendUrl: string
): Promise<RecordingBackend> {
  const requests: Array<RecordedRequest> = []

  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Record the request
      requests.push({
        method: req.method ?? `GET`,
        url: req.url ?? `/`,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(`, `) : (v ?? ``),
          ])
        ),
      })

      // Collect request body
      const chunks: Array<Buffer> = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      const body = Buffer.concat(chunks)

      // Proxy to real backend
      const targetUrl = new URL(req.url ?? `/`, realBackendUrl)
      const proxyHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (key !== `host` && key !== `connection`) {
          proxyHeaders[key] = Array.isArray(value)
            ? value.join(`, `)
            : (value ?? ``)
        }
      }

      try {
        const proxyRes = await fetch(targetUrl.toString(), {
          method: req.method ?? `GET`,
          headers: proxyHeaders,
          body: body.length > 0 ? (body as unknown as BodyInit) : undefined,
        })

        const responseHeaders: Record<string, string> = {}
        proxyRes.headers.forEach((value, key) => {
          responseHeaders[key] = value
        })

        res.writeHead(proxyRes.status, responseHeaders)

        if (proxyRes.body) {
          const reader = proxyRes.body.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
            }
          } finally {
            reader.releaseLock()
          }
        }
        res.end()
      } catch {
        res.writeHead(502)
        res.end(`Backend proxy error`)
      }
    }
  )

  const port = 10000 + Math.floor(Math.random() * 50000)

  await new Promise<void>((resolve, reject) => {
    server.on(`error`, reject)
    server.listen(port, `localhost`, () => {
      server.removeListener(`error`, reject)
      resolve()
    })
  })

  return {
    url: `http://localhost:${port}`,
    requests,
    clear: () => {
      requests.length = 0
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const JWT_SECRET = `test-secret-key-for-development`

let upstream: MockUpstreamServer
let realBackend: { url: string; stop: () => Promise<void> }
let recordingBackend: RecordingBackend

// Proxy instances – created per describe block
let defaultProxy: ProxyServer
let customPathProxy: ProxyServer
let staticHeadersProxy: ProxyServer
let fnHeadersProxy: ProxyServer
let asyncHeadersProxy: ProxyServer

beforeAll(async () => {
  // 1. Start mock upstream (simulates the AI provider)
  const basePort = 10000 + Math.floor(Math.random() * 50000)
  upstream = await createMockUpstream({ port: basePort, host: `localhost` })

  // 2. Start real durable-streams server
  const { DurableStreamTestServer } = await import(`@durable-streams/server`)
  const ds = new DurableStreamTestServer({
    port: basePort + 1,
    host: `localhost`,
  })
  const dsUrl = await ds.start()
  realBackend = { url: dsUrl, stop: () => ds.stop() }

  // 3. Start recording backend (sits between proxy and real backend)
  recordingBackend = await createRecordingBackend(dsUrl)

  // 4. Start proxy variants
  const allowlist = [`http://localhost:*/**`]

  defaultProxy = await createProxyServer({
    port: basePort + 3,
    host: `localhost`,
    durableStreamsUrl: recordingBackend.url,
    allowlist,
    jwtSecret: JWT_SECRET,
  })

  customPathProxy = await createProxyServer({
    port: basePort + 4,
    host: `localhost`,
    durableStreamsUrl: recordingBackend.url,
    allowlist,
    jwtSecret: JWT_SECRET,
    streamPath: (id) => `/v1/myproject/stream/${id}`,
  })

  staticHeadersProxy = await createProxyServer({
    port: basePort + 5,
    host: `localhost`,
    durableStreamsUrl: recordingBackend.url,
    allowlist,
    jwtSecret: JWT_SECRET,
    backendHeaders: {
      "X-Custom": `static-value`,
      Authorization: `Bearer static-token`,
    },
  })

  fnHeadersProxy = await createProxyServer({
    port: basePort + 6,
    host: `localhost`,
    durableStreamsUrl: recordingBackend.url,
    allowlist,
    jwtSecret: JWT_SECRET,
    backendHeaders: ({ streamId, method }) => ({
      "X-Stream-Id": streamId,
      "X-Method": method,
    }),
  })

  asyncHeadersProxy = await createProxyServer({
    port: basePort + 7,
    host: `localhost`,
    durableStreamsUrl: recordingBackend.url,
    allowlist,
    jwtSecret: JWT_SECRET,
    backendHeaders: async ({ streamId }) => {
      // Simulate async token minting
      await new Promise((r) => setTimeout(r, 5))
      return { Authorization: `Bearer async-jwt-for-${streamId}` }
    },
  })
})

afterAll(async () => {
  await Promise.all([
    defaultProxy.stop(),
    customPathProxy.stop(),
    staticHeadersProxy.stop(),
    fnHeadersProxy.stop(),
    asyncHeadersProxy.stop(),
  ])
  await recordingBackend.stop()
  await realBackend.stop()
  await upstream.stop()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createStreamVia(
  proxyUrl: string,
  upstreamUrl: string
): Promise<{ streamId: string; streamUrl: string }> {
  const url = new URL(`/v1/proxy`, proxyUrl)
  url.searchParams.set(`secret`, JWT_SECRET)

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers: {
      "Upstream-URL": upstreamUrl,
      "Upstream-Method": `POST`,
      "Content-Type": `application/json`,
    },
    body: JSON.stringify({ prompt: `test` }),
  })

  expect(response.status).toBe(201)

  const location = response.headers.get(`Location`)!
  const streamUrl = new URL(location, proxyUrl).toString()
  const match = new URL(streamUrl).pathname.match(/\/v1\/proxy\/([^/]+)\/?$/)
  const streamId = decodeURIComponent(match![1]!)

  return { streamId, streamUrl }
}

async function headStreamVia(
  proxyUrl: string,
  streamId: string
): Promise<number> {
  const url = new URL(`/v1/proxy/${streamId}`, proxyUrl)
  url.searchParams.set(`secret`, JWT_SECRET)
  const res = await fetch(url.toString(), { method: `HEAD` })
  return res.status
}

async function waitForReady(proxyUrl: string, streamId: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    if ((await headStreamVia(proxyUrl, streamId)) === 200) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for stream ${streamId}`)
}

async function deleteStreamVia(
  proxyUrl: string,
  streamId: string
): Promise<number> {
  const url = new URL(`/v1/proxy/${streamId}`, proxyUrl)
  url.searchParams.set(`secret`, JWT_SECRET)
  const res = await fetch(url.toString(), { method: `DELETE` })
  return res.status
}

async function readStreamVia(
  streamUrl: string
): Promise<{ status: number; body: string }> {
  const url = new URL(streamUrl)
  url.searchParams.set(`offset`, `-1`)
  const res = await fetch(url.toString())
  return { status: res.status, body: await res.text() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`default behavior (no streamPath or backendHeaders)`, () => {
  it(`uses /v1/streams/:id path by default`, async () => {
    upstream.setResponse(createAIStreamingResponse([`default`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      defaultProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(defaultProxy.url, streamId)

    // The recording backend should have received requests with /v1/streams/<id>
    const backendRequests = recordingBackend.requests.filter((r) =>
      r.url.includes(streamId)
    )
    expect(backendRequests.length).toBeGreaterThan(0)

    for (const req of backendRequests) {
      expect(req.url).toMatch(new RegExp(`^/v1/streams/${streamId}`))
    }
  })

  it(`sends no extra headers by default`, async () => {
    upstream.setResponse(createAIStreamingResponse([`default`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      defaultProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(defaultProxy.url, streamId)

    const backendRequests = recordingBackend.requests.filter((r) =>
      r.url.includes(streamId)
    )
    expect(backendRequests.length).toBeGreaterThan(0)

    // Should NOT have custom headers
    for (const req of backendRequests) {
      expect(req.headers[`x-custom`]).toBeUndefined()
      expect(req.headers[`x-stream-id`]).toBeUndefined()
    }
  })
})

describe(`custom streamPath`, () => {
  it(`produces correct backend URLs`, async () => {
    upstream.setResponse(createAIStreamingResponse([`custom-path`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      customPathProxy.url,
      upstream.url + `/v1/chat`
    )

    // The recording backend sees /v1/myproject/stream/<id> but the real
    // backend behind it expects /v1/streams/<id>, so the create will fail.
    // That's expected — we're testing the URL that was *sent*.

    // Wait a bit for the PUT to be recorded
    await new Promise((r) => setTimeout(r, 200))

    const backendRequests = recordingBackend.requests.filter((r) =>
      r.url.includes(streamId)
    )
    expect(backendRequests.length).toBeGreaterThan(0)

    for (const req of backendRequests) {
      expect(req.url).toMatch(new RegExp(`^/v1/myproject/stream/${streamId}`))
      // Verify the old default path is NOT used
      expect(req.url).not.toContain(`/v1/streams/`)
    }
  })
})

describe(`static backendHeaders`, () => {
  it(`includes static headers on all backend requests`, async () => {
    upstream.setResponse(createAIStreamingResponse([`static-hdrs`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      staticHeadersProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(staticHeadersProxy.url, streamId)

    const backendRequests = recordingBackend.requests.filter((r) =>
      r.url.includes(streamId)
    )
    expect(backendRequests.length).toBeGreaterThan(0)

    for (const req of backendRequests) {
      expect(req.headers[`x-custom`]).toBe(`static-value`)
      expect(req.headers[`authorization`]).toBe(`Bearer static-token`)
    }
  })

  it(`includes static headers on HEAD requests`, async () => {
    upstream.setResponse(createAIStreamingResponse([`head-hdrs`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      staticHeadersProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(staticHeadersProxy.url, streamId)

    // Now do a HEAD
    recordingBackend.clear()
    await headStreamVia(staticHeadersProxy.url, streamId)

    const headRequests = recordingBackend.requests.filter(
      (r) => r.method === `HEAD`
    )
    expect(headRequests.length).toBe(1)
    expect(headRequests[0]!.headers[`x-custom`]).toBe(`static-value`)
    expect(headRequests[0]!.headers[`authorization`]).toBe(
      `Bearer static-token`
    )
  })

  it(`includes static headers on DELETE requests`, async () => {
    upstream.setResponse(createAIStreamingResponse([`delete-hdrs`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      staticHeadersProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(staticHeadersProxy.url, streamId)

    recordingBackend.clear()
    await deleteStreamVia(staticHeadersProxy.url, streamId)

    const deleteRequests = recordingBackend.requests.filter(
      (r) => r.method === `DELETE`
    )
    expect(deleteRequests.length).toBe(1)
    expect(deleteRequests[0]!.headers[`x-custom`]).toBe(`static-value`)
    expect(deleteRequests[0]!.headers[`authorization`]).toBe(
      `Bearer static-token`
    )
  })

  it(`includes static headers on GET (read) requests`, async () => {
    upstream.setResponse(createAIStreamingResponse([`read-hdrs`]))
    recordingBackend.clear()

    const { streamId, streamUrl } = await createStreamVia(
      staticHeadersProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(staticHeadersProxy.url, streamId)

    recordingBackend.clear()
    await readStreamVia(streamUrl)

    const getRequests = recordingBackend.requests.filter(
      (r) => r.method === `GET`
    )
    expect(getRequests.length).toBe(1)
    expect(getRequests[0]!.headers[`x-custom`]).toBe(`static-value`)
    expect(getRequests[0]!.headers[`authorization`]).toBe(`Bearer static-token`)
  })
})

describe(`function backendHeaders`, () => {
  it(`calls function with correct { streamId, method } context`, async () => {
    upstream.setResponse(createAIStreamingResponse([`fn-hdrs`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      fnHeadersProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(fnHeadersProxy.url, streamId)

    const backendRequests = recordingBackend.requests.filter((r) =>
      r.url.includes(streamId)
    )
    expect(backendRequests.length).toBeGreaterThan(0)

    // Check that the function was called with the correct streamId
    for (const req of backendRequests) {
      expect(req.headers[`x-stream-id`]).toBe(streamId)
      expect(req.headers[`x-method`]).toBe(req.method)
    }
  })

  it(`receives PUT method on stream creation`, async () => {
    upstream.setResponse(createAIStreamingResponse([`fn-put`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      fnHeadersProxy.url,
      upstream.url + `/v1/chat`
    )

    // Wait a bit for the PUT to be recorded
    await new Promise((r) => setTimeout(r, 200))

    const putRequests = recordingBackend.requests.filter(
      (r) => r.method === `PUT` && r.url.includes(streamId)
    )
    expect(putRequests.length).toBe(1)
    expect(putRequests[0]!.headers[`x-method`]).toBe(`PUT`)
    expect(putRequests[0]!.headers[`x-stream-id`]).toBe(streamId)
  })
})

describe(`async backendHeaders`, () => {
  it(`resolves async function and includes headers`, async () => {
    upstream.setResponse(createAIStreamingResponse([`async-hdrs`]))
    recordingBackend.clear()

    const { streamId } = await createStreamVia(
      asyncHeadersProxy.url,
      upstream.url + `/v1/chat`
    )

    await waitForReady(asyncHeadersProxy.url, streamId)

    const backendRequests = recordingBackend.requests.filter((r) =>
      r.url.includes(streamId)
    )
    expect(backendRequests.length).toBeGreaterThan(0)

    for (const req of backendRequests) {
      expect(req.headers[`authorization`]).toBe(
        `Bearer async-jwt-for-${streamId}`
      )
    }
  })
})

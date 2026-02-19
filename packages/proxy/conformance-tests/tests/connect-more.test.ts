import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connectProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
import { getRuntime } from "../runtime.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

beforeAll(async () => {
  upstream = await createMockUpstream()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: connect more`, () => {
  it(`works without Upstream-URL (service-auth-only mode)`, async () => {
    if (!getRuntime().capabilities.connect) return
    const result = await connectProxyStream({
      streamId: `session-no-upstream-url-${Date.now()}`,
    })
    expect([200, 201]).toContain(result.status)
    expect(result.headers.get(`Location`)).toBeTruthy()
    expect(await result.text()).toBe(``)
  })

  it(`forwards Stream-Id header to connect handler`, async () => {
    if (!getRuntime().capabilities.connect) return
    let receivedStreamId: string | undefined
    upstream.setHandler((req, res) => {
      receivedStreamId = req.headers[`stream-id`] as string
      res.writeHead(200, { "Content-Type": `application/json` })
      res.end(JSON.stringify({ ok: true }))
    })
    const streamId = `session-forward-id-${Date.now()}`
    const result = await connectProxyStream({
      streamId,
      upstreamUrl: upstream.url + `/connect`,
    })
    expect([200, 201]).toContain(result.status)
    expect(receivedStreamId).toBe(streamId)
  })

  it(`returns fresh signed URL in Location header`, async () => {
    if (!getRuntime().capabilities.connect) return
    const result = await connectProxyStream({
      streamId: `session-signed-url-${Date.now()}`,
      upstreamUrl: upstream.url + `/connect`,
    })
    const location = result.headers.get(`Location`)
    expect(location).toBeTruthy()
    const url = new URL(location!, getRuntime().getBaseUrl())
    expect(url.searchParams.get(`expires`)).toBeTruthy()
    expect(url.searchParams.get(`signature`)).toBeTruthy()
  })

  it(`does not return upstream response headers on connect`, async () => {
    if (!getRuntime().capabilities.connect) return
    const result = await connectProxyStream({
      streamId: `session-connect-headers-${Date.now()}`,
    })
    expect([200, 201]).toContain(result.status)
    expect(result.headers.get(`Upstream-Content-Type`)).toBeNull()
    expect(result.headers.get(`Stream-Response-Id`)).toBeNull()
  })

  it(`returns 401 when service auth is missing`, async () => {
    if (!getRuntime().capabilities.connect) return
    const runtime = getRuntime()
    const url = runtime.adapter.connectUrl(
      runtime.getBaseUrl(),
      `session-no-secret-${Date.now()}`
    )
    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: { "Upstream-URL": upstream.url + `/connect` },
    })
    expect(response.status).toBe(401)
  })

  it(`respects Stream-Signed-URL-TTL header`, async () => {
    if (!getRuntime().capabilities.connect) return
    const streamId = `session-ttl-${Date.now()}`
    const result = await connectProxyStream({
      streamId,
      upstreamUrl: upstream.url + `/connect`,
      headers: { "Stream-Signed-URL-TTL": `1800` },
    })
    expect([200, 201]).toContain(result.status)
    const location = result.headers.get(`Location`)
    expect(location).toBeTruthy()
    const expires = parseInt(
      new URL(location!, getRuntime().getBaseUrl()).searchParams.get(
        `expires`
      )!,
      10
    )
    const expectedExpires = Math.floor(Date.now() / 1000) + 1800
    expect(expires).toBeGreaterThan(expectedExpires - 5)
    expect(expires).toBeLessThan(expectedExpires + 5)
  })

  it(`does not reject large Stream-Signed-URL-TTL values`, async () => {
    if (!getRuntime().capabilities.connect) return
    const result = await connectProxyStream({
      streamId: `session-large-ttl-${Date.now()}`,
      upstreamUrl: upstream.url + `/connect`,
      headers: { "Stream-Signed-URL-TTL": `31536000` },
    })
    expect([200, 201]).toContain(result.status)
    expect(result.headers.get(`Location`)).toBeTruthy()
  })

  it(`forwards client auth headers to connect handler`, async () => {
    if (!getRuntime().capabilities.connect) return
    let receivedAuthHeader: string | undefined
    upstream.setHandler((req, res) => {
      receivedAuthHeader = req.headers.authorization
      res.writeHead(200, { "Content-Type": `application/json` })
      res.end(JSON.stringify({ ok: true }))
    })

    const response = await connectProxyStream({
      streamId: `session-auth-${Date.now()}`,
      upstreamUrl: upstream.url + `/connect`,
      headers: { "Upstream-Authorization": `Bearer user-token-123` },
    })
    expect([200, 201]).toContain(response.status)
    expect(receivedAuthHeader).toBe(`Bearer user-token-123`)
  })
})

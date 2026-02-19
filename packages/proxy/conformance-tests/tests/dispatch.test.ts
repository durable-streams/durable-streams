import { describe, expect, it } from "vitest"
import { getRuntime } from "../runtime.js"

describe(`proxy conformance: strict action dispatch`, () => {
  it(`returns INVALID_ACTION for POST /v1/proxy?action=connect`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.createUrl(runtime.getBaseUrl())
    url.searchParams.set(`action`, `connect`)
    url.searchParams.set(`streamId`, `ignored`)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(url, headers)

    const response = await fetch(url.toString(), { method: `POST`, headers })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_ACTION`)
  })

  it(`does not treat Session-Id as connect on POST /v1/proxy`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.createUrl(runtime.getBaseUrl())
    const headers = new Headers({ "Session-Id": `legacy-session-id` })
    await runtime.adapter.applyServiceAuth(url, headers)

    const response = await fetch(url.toString(), { method: `POST`, headers })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })

  it(`returns INVALID_ACTION for GET /v1/proxy/:streamId?action=connect`, async () => {
    const runtime = getRuntime()
    const readUrl = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      `dispatch-read-${Date.now()}`
    )
    readUrl.searchParams.set(`action`, `connect`)
    readUrl.searchParams.set(`offset`, `-1`)
    const response = await fetch(readUrl.toString())
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_ACTION`)
  })

  it(`returns INVALID_ACTION for HEAD and DELETE with action query`, async () => {
    const runtime = getRuntime()
    const streamId = `dispatch-action-${Date.now()}`
    const base = runtime.adapter.streamUrl(runtime.getBaseUrl(), streamId)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(base, headers)

    const headUrl = new URL(base)
    headUrl.searchParams.set(`action`, `connect`)
    const headResponse = await fetch(headUrl.toString(), {
      method: `HEAD`,
      headers,
    })
    expect(headResponse.status).toBe(400)

    const deleteUrl = new URL(base)
    deleteUrl.searchParams.set(`action`, `abort`)
    const deleteResponse = await fetch(deleteUrl.toString(), {
      method: `DELETE`,
      headers,
    })
    expect(deleteResponse.status).toBe(400)
    const body = await deleteResponse.json()
    expect(body.error.code).toBe(`INVALID_ACTION`)
  })
})

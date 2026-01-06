/**
 * Conformance test suite for Durable Streams server implementations
 *
 * This package provides a standardized test suite that can be run against
 * any server implementation to verify protocol compliance.
 */

import { describe, expect, test } from "vitest"
import * as fc from "fast-check"
import {
  DurableStream,
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "@durable-streams/client"

export interface ConformanceTestOptions {
  /** Base URL of the server to test */
  baseUrl: string
  /** Timeout for long-poll tests in milliseconds (default: 20000) */
  longPollTimeoutMs?: number
}

/**
 * Helper to fetch SSE stream and read until a condition is met.
 * Handles AbortController, timeout, and cleanup automatically.
 */
async function fetchSSE(
  url: string,
  opts: {
    timeoutMs?: number
    maxChunks?: number
    untilContent?: string
    signal?: AbortSignal
    headers?: Record<string, string>
  } = {}
): Promise<{ response: Response; received: string }> {
  const {
    timeoutMs = 2000,
    maxChunks = 10,
    untilContent,
    headers = {},
    signal,
  } = opts

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) {
    signal.addEventListener(`abort`, () => controller.abort())
  }

  try {
    const response = await fetch(url, {
      method: `GET`,
      headers,
      signal: controller.signal,
    })

    if (!response.body) {
      clearTimeout(timeoutId)
      return { response, received: `` }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ``

    let untilContentIndex = -1
    for (let i = 0; i < maxChunks; i++) {
      const { done, value } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
      if (
        untilContent &&
        received.includes(untilContent) &&
        untilContentIndex < 0
      ) {
        untilContentIndex = received.indexOf(untilContent)
      }

      const normalized = received.replace(/\r\n/g, `\n`)
      if (
        untilContentIndex >= 0 &&
        normalized.lastIndexOf(`\n\n`) > untilContentIndex
      ) {
        break
      }
    }

    clearTimeout(timeoutId)
    reader.cancel()

    return { response, received }
  } catch (e) {
    clearTimeout(timeoutId)
    if (e instanceof Error && e.name === `AbortError`) {
      // Return empty result on timeout/abort
      return { response: new Response(), received: `` }
    }
    throw e
  }
}

/**
 * Parse SSE events from raw SSE text.
 * Handles multi-line data correctly by joining data: lines per the SSE spec.
 * Returns an array of parsed events with type and data.
 */
function parseSSEEvents(
  sseText: string
): Array<{ type: string; data: string }> {
  const events: Array<{ type: string; data: string }> = []
  const normalized = sseText.replace(/\r\n/g, `\n`).replace(/\r/g, `\n`)

  // Split by double newlines (event boundaries)
  const eventBlocks = normalized.split(`\n\n`).filter((block) => block.trim())

  for (const block of eventBlocks) {
    const lines = block.split(`\n`)
    let eventType = ``
    const dataLines: Array<string> = []

    for (const line of lines) {
      if (line.startsWith(`event:`)) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith(`data:`)) {
        // Per SSE spec, strip the optional space after "data:"
        const content = line.slice(5)
        dataLines.push(content.startsWith(` `) ? content.slice(1) : content)
      }
    }

    if (eventType && dataLines.length > 0) {
      // Join data lines with newlines per SSE spec
      events.push({ type: eventType, data: dataLines.join(`\n`) })
    }
  }

  return events
}

/**
 * Run the full conformance test suite against a server
 */
export function runConformanceTests(options: ConformanceTestOptions): void {
  // Access options.baseUrl directly instead of destructuring to support
  // mutable config objects (needed for dynamic port assignment)
  const getBaseUrl = () => options.baseUrl
  const getLongPollTestTimeoutMs = () =>
    (options.longPollTimeoutMs ?? 20_000) + 1_000

  // ============================================================================
  // Basic Stream Operations
  // ============================================================================

  describe(`Basic Stream Operations`, () => {
    test(`should create a stream`, async () => {
      const streamPath = `/v1/stream/create-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      expect(stream.url).toBe(`${getBaseUrl()}${streamPath}`)
    })

    test(`should allow idempotent create with same config`, async () => {
      const streamPath = `/v1/stream/duplicate-test-${Date.now()}`

      // Create first stream
      await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      // Create again with same config - should succeed (idempotent)
      await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })
    })

    test(`should reject create with different config (409)`, async () => {
      const streamPath = `/v1/stream/config-mismatch-test-${Date.now()}`

      // Create with text/plain
      await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      // Try to create with different content type - should fail
      await expect(
        DurableStream.create({
          url: `${getBaseUrl()}${streamPath}`,
          contentType: `application/json`,
        })
      ).rejects.toThrow()
    })

    test(`should delete a stream`, async () => {
      const streamPath = `/v1/stream/delete-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.delete()

      // Verify it's gone by trying to read
      await expect(stream.stream({ live: false })).rejects.toThrow()
    })

    test(`should properly isolate recreated stream after delete`, async () => {
      const streamPath = `/v1/stream/delete-recreate-test-${Date.now()}`

      // Create stream and append data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `old data`,
      })

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: ` more old data`,
      })

      // Verify old data exists
      const readOld = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const oldText = await readOld.text()
      expect(oldText).toBe(`old data more old data`)

      // Delete the stream
      const deleteResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `DELETE`,
      })
      expect(deleteResponse.status).toBe(204)

      // Immediately recreate at same URL with different data
      const recreateResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `new data`,
      })
      expect(recreateResponse.status).toBe(201)

      // Read the new stream - should only see new data, not old
      const readNew = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const newText = await readNew.text()
      expect(newText).toBe(`new data`)
      expect(newText).not.toContain(`old data`)

      // Verify Stream-Up-To-Date is true (we're caught up on new stream)
      expect(readNew.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)

      // Append to the new stream to verify it's fully functional
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: ` appended`,
      })

      // Read again and verify
      const finalRead = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const finalText = await finalRead.text()
      expect(finalText).toBe(`new data appended`)
    })
  })

  // ============================================================================
  // Append Operations
  // ============================================================================

  describe(`Append Operations`, () => {
    test(`should append string data`, async () => {
      const streamPath = `/v1/stream/append-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`hello world`)

      const res = await stream.stream({ live: false })
      const text = await res.text()
      expect(text).toBe(`hello world`)
    })

    test(`should append multiple chunks`, async () => {
      const streamPath = `/v1/stream/multi-append-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`chunk1`)
      await stream.append(`chunk2`)
      await stream.append(`chunk3`)

      const res = await stream.stream({ live: false })
      const text = await res.text()
      expect(text).toBe(`chunk1chunk2chunk3`)
    })

    test(`should enforce sequence ordering with seq`, async () => {
      const streamPath = `/v1/stream/seq-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`first`, { seq: `001` })
      await stream.append(`second`, { seq: `002` })

      // Trying to append with lower seq should fail
      await expect(stream.append(`invalid`, { seq: `001` })).rejects.toThrow()
    })
  })

  // ============================================================================
  // Read Operations
  // ============================================================================

  describe(`Read Operations`, () => {
    test(`should read empty stream`, async () => {
      const streamPath = `/v1/stream/read-empty-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      const res = await stream.stream({ live: false })
      const body = await res.body()
      expect(body.length).toBe(0)
      expect(res.upToDate).toBe(true)
    })

    test(`should read stream with data`, async () => {
      const streamPath = `/v1/stream/read-data-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`hello`)

      const res = await stream.stream({ live: false })
      const text = await res.text()
      expect(text).toBe(`hello`)
      expect(res.upToDate).toBe(true)
    })

    test(`should read from offset`, async () => {
      const streamPath = `/v1/stream/read-offset-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`first`)
      const res1 = await stream.stream({ live: false })
      await res1.text()
      const firstOffset = res1.offset

      await stream.append(`second`)

      const res2 = await stream.stream({ offset: firstOffset, live: false })
      const text = await res2.text()
      expect(text).toBe(`second`)
    })
  })

  // ============================================================================
  // Long-Poll Operations
  // ============================================================================

  describe(`Long-Poll Operations`, () => {
    test(
      `should wait for new data with long-poll`,
      async () => {
        const streamPath = `/v1/stream/longpoll-test-${Date.now()}`
        const stream = await DurableStream.create({
          url: `${getBaseUrl()}${streamPath}`,
          contentType: `text/plain`,
        })

        const receivedData: Array<string> = []

        // Start reading in long-poll mode
        const readPromise = (async () => {
          const res = await stream.stream({ live: `long-poll` })
          await new Promise<void>((resolve) => {
            const unsubscribe = res.subscribeBytes((chunk) => {
              if (chunk.data.length > 0) {
                receivedData.push(new TextDecoder().decode(chunk.data))
              }
              if (receivedData.length >= 1) {
                unsubscribe()
                res.cancel()
                resolve()
              }
              return Promise.resolve()
            })
          })
        })()

        // Wait a bit for the long-poll to be active
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Append data while long-poll is waiting
        await stream.append(`new data`)

        await readPromise

        expect(receivedData).toContain(`new data`)
      },
      getLongPollTestTimeoutMs()
    )

    test(`should return immediately if data already exists`, async () => {
      const streamPath = `/v1/stream/longpoll-immediate-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      // Add data first
      await stream.append(`existing data`)

      // Read should return existing data immediately
      const res = await stream.stream({ live: false })
      const text = await res.text()

      expect(text).toBe(`existing data`)
    })
  })

  // ============================================================================
  // HTTP Protocol Tests
  // ============================================================================

  describe(`HTTP Protocol`, () => {
    test(`should return correct headers on PUT`, async () => {
      const streamPath = `/v1/stream/put-headers-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
        },
      })

      expect(response.status).toBe(201)
      expect(response.headers.get(`content-type`)).toBe(`text/plain`)
      expect(response.headers.get(STREAM_OFFSET_HEADER)).toBeDefined()
    })

    test(`should return 200 on idempotent PUT with same config`, async () => {
      const streamPath = `/v1/stream/duplicate-put-test-${Date.now()}`

      // First PUT
      const firstResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })
      expect(firstResponse.status).toBe(201)

      // Second PUT with same config should succeed
      const secondResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })
      expect(secondResponse.status).toBe(200)
    })

    test(`should return 409 on PUT with different config`, async () => {
      const streamPath = `/v1/stream/config-conflict-test-${Date.now()}`

      // First PUT with text/plain
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Second PUT with different content type should fail
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })

      expect(response.status).toBe(409)
    })

    test(`should return correct headers on POST`, async () => {
      const streamPath = `/v1/stream/post-headers-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append data
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `hello world`,
      })

      expect(response.status).toBe(204)
      expect(response.headers.get(STREAM_OFFSET_HEADER)).toBeDefined()
    })

    test(`should return 404 on POST to non-existent stream`, async () => {
      const streamPath = `/v1/stream/post-404-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `data`,
      })

      expect(response.status).toBe(404)
    })

    test(`should return 409 on content-type mismatch`, async () => {
      const streamPath = `/v1/stream/content-type-mismatch-test-${Date.now()}`

      // Create with text/plain
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try to append with application/json - valid content-type but doesn't match stream
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{}`,
      })

      expect(response.status).toBe(409)
    })

    test(`should return correct headers on GET`, async () => {
      const streamPath = `/v1/stream/get-headers-test-${Date.now()}`

      // Create and add data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Read data
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get(`content-type`)).toBe(`text/plain`)
      const nextOffset = response.headers.get(STREAM_OFFSET_HEADER)
      expect(nextOffset).toBeDefined()
      expect(response.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)
      const etag = response.headers.get(`etag`)
      expect(etag).toBeDefined()

      const text = await response.text()
      expect(text).toBe(`test data`)
    })

    test(`should return empty body with up-to-date for empty stream`, async () => {
      const streamPath = `/v1/stream/get-empty-test-${Date.now()}`

      // Create empty stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Read empty stream
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get(STREAM_OFFSET_HEADER)).toBeDefined()
      expect(response.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)

      const text = await response.text()
      expect(text).toBe(``)
    })

    test(`should read from offset`, async () => {
      const streamPath = `/v1/stream/get-offset-test-${Date.now()}`

      // Create with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `first`,
      })

      // Append more
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `second`,
      })

      // Get the first offset (after "first")
      const firstResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const firstText = await firstResponse.text()
      expect(firstText).toBe(`firstsecond`)

      // Now create fresh and read from middle offset
      const streamPath2 = `/v1/stream/get-offset-test2-${Date.now()}`
      await fetch(`${getBaseUrl()}${streamPath2}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `first`,
      })
      const middleResponse = await fetch(`${getBaseUrl()}${streamPath2}`, {
        method: `GET`,
      })
      const middleOffset = middleResponse.headers.get(STREAM_OFFSET_HEADER)

      // Append more
      await fetch(`${getBaseUrl()}${streamPath2}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `second`,
      })

      // Read from the middle offset
      const response = await fetch(
        `${getBaseUrl()}${streamPath2}?offset=${middleOffset}`,
        {
          method: `GET`,
        }
      )

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toBe(`second`)
    })

    test(`should return 404 on DELETE non-existent stream`, async () => {
      const streamPath = `/v1/stream/delete-404-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `DELETE`,
      })

      expect(response.status).toBe(404)
    })

    test(`should return 204 on successful DELETE`, async () => {
      const streamPath = `/v1/stream/delete-success-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Delete it
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `DELETE`,
      })

      expect(response.status).toBe(204)

      // Verify it's gone
      const readResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      expect(readResponse.status).toBe(404)
    })

    test(`should enforce sequence ordering`, async () => {
      const streamPath = `/v1/stream/seq-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq 001
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `001`,
        },
        body: `first`,
      })

      // Append with seq 002
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `002`,
        },
        body: `second`,
      })

      // Try to append with seq 001 (regression) - should fail
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `001`,
        },
        body: `invalid`,
      })

      expect(response.status).toBe(409)
    })

    test(`should enforce lexicographic seq ordering ("2" then "10" rejects)`, async () => {
      const streamPath = `/v1/stream/seq-lexicographic-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq "2"
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `2`,
        },
        body: `first`,
      })

      // Try to append with seq "10" - should fail (lexicographically "10" < "2")
      // A numeric implementation would incorrectly accept this (10 > 2)
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `10`,
        },
        body: `second`,
      })

      expect(response.status).toBe(409)
    })

    test(`should allow lexicographic seq ordering ("09" then "10" succeeds)`, async () => {
      const streamPath = `/v1/stream/seq-padded-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq "09"
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `09`,
        },
        body: `first`,
      })

      // Append with seq "10" - should succeed (lexicographically "10" > "09")
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `10`,
        },
        body: `second`,
      })

      expect(response.status).toBe(204)
    })

    test(`should reject duplicate seq values`, async () => {
      const streamPath = `/v1/stream/seq-duplicate-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq "001"
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `001`,
        },
        body: `first`,
      })

      // Try to append with same seq "001" - should fail
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `001`,
        },
        body: `duplicate`,
      })

      expect(response.status).toBe(409)
    })
  })

  // ============================================================================
  // Browser Security Headers (Protocol Section 10.7)
  // ============================================================================

  describe(`Browser Security Headers`, () => {
    test(`should include X-Content-Type-Options: nosniff on GET responses`, async () => {
      const streamPath = `/v1/stream/security-get-nosniff-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Read data
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
    })

    test(`should include X-Content-Type-Options: nosniff on PUT responses`, async () => {
      const streamPath = `/v1/stream/security-put-nosniff-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      expect(response.status).toBe(201)
      expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
    })

    test(`should include X-Content-Type-Options: nosniff on POST responses`, async () => {
      const streamPath = `/v1/stream/security-post-nosniff-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append data
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `data`,
      })

      expect([200, 204]).toContain(response.status)
      expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
    })

    test(`should include X-Content-Type-Options: nosniff on HEAD responses`, async () => {
      const streamPath = `/v1/stream/security-head-nosniff-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // HEAD request
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
    })

    test(`should include Cross-Origin-Resource-Policy header on GET responses`, async () => {
      const streamPath = `/v1/stream/security-corp-get-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/octet-stream` },
        body: new Uint8Array([1, 2, 3, 4]),
      })

      // Read data
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      expect(response.status).toBe(200)
      const corp = response.headers.get(`cross-origin-resource-policy`)
      expect(corp).toBeDefined()
      expect([`cross-origin`, `same-origin`, `same-site`]).toContain(corp)
    })

    test(`should include Cache-Control: no-store on HEAD responses`, async () => {
      const streamPath = `/v1/stream/security-head-cache-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // HEAD request
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })

      expect(response.status).toBe(200)
      const cacheControl = response.headers.get(`cache-control`)
      expect(cacheControl).toBeDefined()
      expect(cacheControl).toContain(`no-store`)
    })

    test(`should include X-Content-Type-Options: nosniff on SSE responses`, async () => {
      const streamPath = `/v1/stream/security-sse-nosniff-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({ test: `data` }),
      })

      // Get offset
      const headResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })
      const offset = headResponse.headers.get(STREAM_OFFSET_HEADER) ?? `-1`

      // SSE request with abort controller
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 500)

      try {
        const response = await fetch(
          `${getBaseUrl()}${streamPath}?offset=${offset}&live=sse`,
          {
            method: `GET`,
            signal: controller.signal,
          }
        )

        expect(response.status).toBe(200)
        expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
      } catch (e) {
        // AbortError is expected
        if (!(e instanceof Error && e.name === `AbortError`)) {
          throw e
        }
      } finally {
        clearTimeout(timeoutId)
      }
    })

    test(`should include X-Content-Type-Options: nosniff on long-poll responses`, async () => {
      const streamPath = `/v1/stream/security-longpoll-nosniff-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `initial data`,
      })

      // Get offset
      const headResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })
      const offset = headResponse.headers.get(STREAM_OFFSET_HEADER) ?? `-1`

      // Long-poll request (will likely return 204 if no new data)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 500)

      try {
        const response = await fetch(
          `${getBaseUrl()}${streamPath}?offset=${offset}&live=long-poll`,
          {
            method: `GET`,
            signal: controller.signal,
          }
        )

        // Either 200 (data) or 204 (timeout) - both should have nosniff
        expect([200, 204]).toContain(response.status)
        expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
      } catch (e) {
        // AbortError is acceptable if request times out
        if (!(e instanceof Error && e.name === `AbortError`)) {
          throw e
        }
      } finally {
        clearTimeout(timeoutId)
      }
    })

    test(`should include security headers on error responses`, async () => {
      const streamPath = `/v1/stream/security-error-headers-${Date.now()}`

      // Try to read non-existent stream (404)
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      expect(response.status).toBe(404)
      // Security headers should be present even on error responses
      expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
    })
  })

  // ============================================================================
  // TTL and Expiry Validation
  // ============================================================================

  describe(`TTL and Expiry Validation`, () => {
    test(`should reject both TTL and Expires-At (400)`, async () => {
      const streamPath = `/v1/stream/ttl-expires-conflict-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `3600`,
          "Stream-Expires-At": new Date(Date.now() + 3600000).toISOString(),
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should reject invalid TTL (non-integer)`, async () => {
      const streamPath = `/v1/stream/ttl-invalid-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `abc`,
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should reject negative TTL`, async () => {
      const streamPath = `/v1/stream/ttl-negative-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `-1`,
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should accept valid TTL`, async () => {
      const streamPath = `/v1/stream/ttl-valid-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `3600`,
        },
      })

      expect([200, 201]).toContain(response.status)
    })

    test(`should accept valid Expires-At`, async () => {
      const streamPath = `/v1/stream/expires-valid-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-Expires-At": new Date(Date.now() + 3600000).toISOString(),
        },
      })

      expect([200, 201]).toContain(response.status)
    })
  })

  // ============================================================================
  // Case-Insensitivity Tests
  // ============================================================================

  describe(`Case-Insensitivity`, () => {
    test(`should treat content-type case-insensitively`, async () => {
      const streamPath = `/v1/stream/case-content-type-test-${Date.now()}`

      // Create with lowercase content-type
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with mixed case - should succeed
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `TEXT/PLAIN` },
        body: `test`,
      })

      expect(response.status).toBe(204)
    })

    test(`should allow idempotent create with different case content-type`, async () => {
      const streamPath = `/v1/stream/case-idempotent-test-${Date.now()}`

      // Create with lowercase
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })
      expect(response1.status).toBe(201)

      // PUT again with uppercase - should be idempotent
      const response2 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `APPLICATION/JSON` },
      })
      expect(response2.status).toBe(200)
    })

    test(`should accept headers with different casing`, async () => {
      const streamPath = `/v1/stream/case-header-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with different header casing (lowercase)
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "content-type": `text/plain`,
          "stream-seq": `001`,
        },
        body: `test`,
      })

      expect(response.status).toBe(204)
    })
  })

  // ============================================================================
  // Content-Type Validation
  // ============================================================================

  describe(`Content-Type Validation`, () => {
    test(`should enforce content-type match on append`, async () => {
      const streamPath = `/v1/stream/content-type-enforcement-test-${Date.now()}`

      // Create with text/plain
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try to append with application/json - valid but doesn't match stream (409)
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{"test": true}`,
      })

      expect(response.status).toBe(409)
    })

    test(`should allow append with matching content-type`, async () => {
      const streamPath = `/v1/stream/content-type-match-test-${Date.now()}`

      // Create with application/json
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })

      // Append with same content-type - should succeed
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{"test": true}`,
      })

      expect(response.status).toBe(204)
    })

    test(`should return stream content-type on GET`, async () => {
      const streamPath = `/v1/stream/content-type-get-test-${Date.now()}`

      // Create with application/json
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
        body: `{"initial": true}`,
      })

      // Read and verify content-type
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get(`content-type`)).toBe(`application/json`)
    })
  })

  // ============================================================================
  // HEAD Metadata Tests
  // ============================================================================

  describe(`HEAD Metadata`, () => {
    test(`should return metadata without body`, async () => {
      const streamPath = `/v1/stream/head-test-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // HEAD request
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get(`content-type`)).toBe(`text/plain`)
      expect(response.headers.get(STREAM_OFFSET_HEADER)).toBeDefined()

      // Body should be empty
      const text = await response.text()
      expect(text).toBe(``)
    })

    test(`should return 404 for non-existent stream`, async () => {
      const streamPath = `/v1/stream/head-404-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })

      expect(response.status).toBe(404)
    })

    test(`should return tail offset`, async () => {
      const streamPath = `/v1/stream/head-offset-test-${Date.now()}`

      // Create empty stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // HEAD should show initial offset
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })
      const offset1 = response1.headers.get(STREAM_OFFSET_HEADER)
      expect(offset1).toBeDefined()

      // Append data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      // HEAD should show updated offset
      const response2 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })
      const offset2 = response2.headers.get(STREAM_OFFSET_HEADER)
      expect(offset2).toBeDefined()
      expect(offset2).not.toBe(offset1)
    })
  })

  // ============================================================================
  // Offset Validation and Resumability
  // ============================================================================

  describe(`Offset Validation and Resumability`, () => {
    test(`should accept -1 as sentinel for stream beginning`, async () => {
      const streamPath = `/v1/stream/offset-sentinel-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Using offset=-1 should return data from the beginning
      const response = await fetch(`${getBaseUrl()}${streamPath}?offset=-1`, {
        method: `GET`,
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toBe(`test data`)
      expect(response.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)
    })

    test(`should return same data for offset=-1 and no offset`, async () => {
      const streamPath = `/v1/stream/offset-sentinel-equiv-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `hello world`,
      })

      // Request without offset
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const text1 = await response1.text()

      // Request with offset=-1
      const response2 = await fetch(`${getBaseUrl()}${streamPath}?offset=-1`, {
        method: `GET`,
      })
      const text2 = await response2.text()

      // Both should return the same data
      expect(text1).toBe(text2)
      expect(text1).toBe(`hello world`)
    })

    test(`should reject malformed offset (contains comma)`, async () => {
      const streamPath = `/v1/stream/offset-comma-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      const response = await fetch(`${getBaseUrl()}${streamPath}?offset=0,1`, {
        method: `GET`,
      })

      expect(response.status).toBe(400)
    })

    test(`should reject offset with spaces`, async () => {
      const streamPath = `/v1/stream/offset-spaces-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      const response = await fetch(`${getBaseUrl()}${streamPath}?offset=0 1`, {
        method: `GET`,
      })

      expect(response.status).toBe(400)
    })

    test(`should support resumable reads (no duplicate data)`, async () => {
      const streamPath = `/v1/stream/resumable-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append chunk 1
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `chunk1`,
      })

      // Read chunk 1
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const text1 = await response1.text()
      const offset1 = response1.headers.get(STREAM_OFFSET_HEADER)

      expect(text1).toBe(`chunk1`)
      expect(offset1).toBeDefined()

      // Append chunk 2
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `chunk2`,
      })

      // Read from offset1 - should only get chunk2
      const response2 = await fetch(
        `${getBaseUrl()}${streamPath}?offset=${offset1}`,
        {
          method: `GET`,
        }
      )
      const text2 = await response2.text()

      expect(text2).toBe(`chunk2`)
    })

    test(`should return empty response when reading from tail offset`, async () => {
      const streamPath = `/v1/stream/tail-read-test-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      // Read all data
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const tailOffset = response1.headers.get(STREAM_OFFSET_HEADER)

      // Read from tail offset - should return empty with up-to-date
      const response2 = await fetch(
        `${getBaseUrl()}${streamPath}?offset=${tailOffset}`,
        {
          method: `GET`,
        }
      )

      expect(response2.status).toBe(200)
      const text = await response2.text()
      expect(text).toBe(``)
      expect(response2.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)
    })
  })

  // ============================================================================
  // Protocol Edge Cases
  // ============================================================================

  describe(`Protocol Edge Cases`, () => {
    test(`should reject empty POST body with 400`, async () => {
      const streamPath = `/v1/stream/empty-append-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try to append empty body - should fail
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: ``,
      })

      expect(response.status).toBe(400)
    })

    test(`should handle PUT with initial body correctly`, async () => {
      const streamPath = `/v1/stream/put-initial-body-test-${Date.now()}`
      const initialData = `initial stream content`

      // Create stream with initial content
      const putResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: initialData,
      })

      expect(putResponse.status).toBe(201)
      const nextOffset = putResponse.headers.get(STREAM_OFFSET_HEADER)
      expect(nextOffset).toBeDefined()

      // Verify we can read the initial content
      const getResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      const text = await getResponse.text()
      expect(text).toBe(initialData)
      expect(getResponse.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)
    })

    test(`should preserve data immutability by position`, async () => {
      const streamPath = `/v1/stream/immutability-test-${Date.now()}`

      // Create and append first chunk
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `chunk1`,
      })

      // Read and save the offset after chunk1
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const text1 = await response1.text()
      const offset1 = response1.headers.get(STREAM_OFFSET_HEADER)
      expect(text1).toBe(`chunk1`)

      // Append more chunks
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `chunk2`,
      })

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `chunk3`,
      })

      // Read from the saved offset - should still get chunk2 (position is immutable)
      const response2 = await fetch(
        `${getBaseUrl()}${streamPath}?offset=${offset1}`,
        {
          method: `GET`,
        }
      )
      const text2 = await response2.text()
      expect(text2).toBe(`chunk2chunk3`)
    })

    test(`should generate unique, monotonically increasing offsets`, async () => {
      const streamPath = `/v1/stream/monotonic-offset-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      const offsets: Array<string> = []

      // Append multiple chunks and collect offsets
      for (let i = 0; i < 5; i++) {
        const response = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: `chunk${i}`,
        })

        const offset = response.headers.get(STREAM_OFFSET_HEADER)
        expect(offset).toBeDefined()
        offsets.push(offset!)
      }

      // Verify offsets are unique and strictly increasing (lexicographically)
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]! > offsets[i - 1]!).toBe(true)
      }
    })

    test(`should reject empty offset parameter`, async () => {
      const streamPath = `/v1/stream/empty-offset-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      const response = await fetch(`${getBaseUrl()}${streamPath}?offset=`, {
        method: `GET`,
      })

      expect(response.status).toBe(400)
    })

    test(`should reject multiple offset parameters`, async () => {
      const streamPath = `/v1/stream/multi-offset-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      const response = await fetch(
        `${getBaseUrl()}${streamPath}?offset=a&offset=b`,
        {
          method: `GET`,
        }
      )

      expect(response.status).toBe(400)
    })

    test(`should enforce case-sensitive seq ordering`, async () => {
      const streamPath = `/v1/stream/case-seq-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq "a" (lowercase)
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `a`,
        },
        body: `first`,
      })

      // Try to append with seq "B" (uppercase) - should fail
      // Lexicographically: "B" < "a" in byte order (uppercase comes before lowercase in ASCII)
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `B`,
        },
        body: `second`,
      })

      expect(response.status).toBe(409)
    })

    test(`should handle binary data with integrity`, async () => {
      const streamPath = `/v1/stream/binary-test-${Date.now()}`

      // Create binary stream with various byte values including 0x00 and 0xFF
      const binaryData = new Uint8Array([
        0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff,
      ])

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/octet-stream` },
        body: binaryData,
      })

      // Read back and verify byte-for-byte
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      const buffer = await response.arrayBuffer()
      const result = new Uint8Array(buffer)

      expect(result.length).toBe(binaryData.length)
      for (let i = 0; i < binaryData.length; i++) {
        expect(result[i]).toBe(binaryData[i])
      }
    })

    test(`should return Location header on 201`, async () => {
      const streamPath = `/v1/stream/location-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      expect(response.status).toBe(201)
      const location = response.headers.get(`location`)
      expect(location).toBeDefined()
      // Check that Location contains the correct path (host may vary by server config)
      expect(location!.endsWith(streamPath)).toBe(true)
      // Verify it's a valid absolute URL
      expect(() => new URL(location!)).not.toThrow()
    })

    test(`should reject missing Content-Type on POST`, async () => {
      const streamPath = `/v1/stream/missing-ct-post-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try to append without Content-Type - should fail
      // Note: fetch will try to detect the Content-Type based on the body.
      // Blob with an explicit empty type results in the header being omitted.
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        body: new Blob([`data`], { type: `` }),
      })

      expect(response.status).toBe(400)
    })

    test(`should accept PUT without Content-Type (use default)`, async () => {
      const streamPath = `/v1/stream/no-ct-put-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
      })

      expect([200, 201]).toContain(response.status)
      const contentType = response.headers.get(`content-type`)
      expect(contentType).toBeDefined()
    })

    test(`should ignore unknown query parameters`, async () => {
      const streamPath = `/v1/stream/unknown-param-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Should work fine with unknown params (use -1 to start from beginning)
      const response = await fetch(
        `${getBaseUrl()}${streamPath}?offset=-1&foo=bar&baz=qux`,
        {
          method: `GET`,
        }
      )

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toBe(`test data`)
    })
  })

  // ============================================================================
  // Long-Poll Edge Cases
  // ============================================================================

  describe(`Long-Poll Edge Cases`, () => {
    test(`should require offset parameter for long-poll`, async () => {
      const streamPath = `/v1/stream/longpoll-no-offset-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try long-poll without offset - protocol says offset MUST be provided
      const response = await fetch(
        `${getBaseUrl()}${streamPath}?live=long-poll`,
        {
          method: `GET`,
        }
      )

      expect(response.status).toBe(400)
    })

    test(`should generate Stream-Cursor header on long-poll responses`, async () => {
      const streamPath = `/v1/stream/longpoll-cursor-gen-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Long-poll request without cursor - server MUST generate one
      const response = await fetch(
        `${getBaseUrl()}${streamPath}?offset=-1&live=long-poll`,
        {
          method: `GET`,
        }
      )

      expect(response.status).toBe(200)

      // Server MUST return a Stream-Cursor header
      const cursor = response.headers.get(`Stream-Cursor`)
      expect(cursor).toBeDefined()
      expect(cursor).not.toBeNull()

      // Cursor must be a numeric string (interval number)
      expect(/^\d+$/.test(cursor!)).toBe(true)
    })

    test(`should echo cursor and handle collision with jitter`, async () => {
      const streamPath = `/v1/stream/longpoll-cursor-collision-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // First request to get current cursor
      const response1 = await fetch(
        `${getBaseUrl()}${streamPath}?offset=-1&live=long-poll`,
        {
          method: `GET`,
        }
      )

      expect(response1.status).toBe(200)
      const cursor1 = response1.headers.get(`Stream-Cursor`)
      expect(cursor1).toBeDefined()

      // Immediate second request with same cursor - should get advanced cursor due to collision
      const response2 = await fetch(
        `${getBaseUrl()}${streamPath}?offset=-1&live=long-poll&cursor=${cursor1}`,
        {
          method: `GET`,
        }
      )

      expect(response2.status).toBe(200)
      const cursor2 = response2.headers.get(`Stream-Cursor`)
      expect(cursor2).toBeDefined()

      // The returned cursor MUST be strictly greater than the one we sent
      // (monotonic progression prevents cache cycles)
      expect(parseInt(cursor2!, 10)).toBeGreaterThan(parseInt(cursor1!, 10))
    })

    test(
      `should return Stream-Cursor, Stream-Up-To-Date and Stream-Next-Offset on 204 timeout`,
      async () => {
        const streamPath = `/v1/stream/longpoll-204-headers-test-${Date.now()}`

        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: { "Content-Type": `text/plain` },
        })

        // Get the current tail offset
        const headResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `HEAD`,
        })
        const tailOffset = headResponse.headers.get(STREAM_OFFSET_HEADER)
        expect(tailOffset).toBeDefined()

        // Long-poll at tail offset with a short timeout
        // We use AbortController to limit wait time on our side
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)

        try {
          const response = await fetch(
            `${getBaseUrl()}${streamPath}?offset=${tailOffset}&live=long-poll`,
            {
              method: `GET`,
              signal: controller.signal,
            }
          )

          clearTimeout(timeoutId)

          // If we get a 204, verify headers
          if (response.status === 204) {
            expect(response.headers.get(STREAM_OFFSET_HEADER)).toBeDefined()
            expect(response.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)

            // Server MUST return Stream-Cursor even on 204 timeout
            const cursor = response.headers.get(`Stream-Cursor`)
            expect(cursor).toBeDefined()
            expect(/^\d+$/.test(cursor!)).toBe(true)
          }
          // If we get a 200 (data arrived somehow), that's also valid
          expect([200, 204]).toContain(response.status)
        } catch (e) {
          clearTimeout(timeoutId)
          // AbortError is expected if server timeout is longer than our 5s
          if (e instanceof Error && e.name !== `AbortError`) {
            throw e
          }
          // Test passes - server just has a longer timeout than our abort
        }
      },
      getLongPollTestTimeoutMs()
    )
  })

  // ============================================================================
  // TTL and Expiry Edge Cases
  // ============================================================================

  describe(`TTL and Expiry Edge Cases`, () => {
    test(`should reject TTL with leading zeros`, async () => {
      const streamPath = `/v1/stream/ttl-leading-zeros-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `00060`,
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should reject TTL with plus sign`, async () => {
      const streamPath = `/v1/stream/ttl-plus-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `+60`,
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should reject TTL with float value`, async () => {
      const streamPath = `/v1/stream/ttl-float-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `60.5`,
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should reject TTL with scientific notation`, async () => {
      const streamPath = `/v1/stream/ttl-scientific-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `1e3`,
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should reject invalid Expires-At timestamp`, async () => {
      const streamPath = `/v1/stream/expires-invalid-test-${Date.now()}`

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-Expires-At": `not-a-timestamp`,
        },
      })

      expect(response.status).toBe(400)
    })

    test(`should accept Expires-At with Z timezone`, async () => {
      const streamPath = `/v1/stream/expires-z-test-${Date.now()}`

      const expiresAt = new Date(Date.now() + 3600000).toISOString()

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-Expires-At": expiresAt,
        },
      })

      expect([200, 201]).toContain(response.status)
    })

    test(`should accept Expires-At with timezone offset`, async () => {
      const streamPath = `/v1/stream/expires-offset-test-${Date.now()}`

      // RFC3339 with timezone offset
      const date = new Date(Date.now() + 3600000)
      const expiresAt = date.toISOString().replace(`Z`, `+00:00`)

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-Expires-At": expiresAt,
        },
      })

      expect([200, 201]).toContain(response.status)
    })

    test(`should handle idempotent PUT with same TTL`, async () => {
      const streamPath = `/v1/stream/ttl-idempotent-test-${Date.now()}`

      // Create with TTL
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `3600`,
        },
      })
      expect(response1.status).toBe(201)

      // PUT again with same TTL - should be idempotent
      const response2 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `3600`,
        },
      })
      expect(response2.status).toBe(200)
    })

    test(`should reject idempotent PUT with different TTL`, async () => {
      const streamPath = `/v1/stream/ttl-conflict-test-${Date.now()}`

      // Create with TTL=3600
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `3600`,
        },
      })

      // PUT again with different TTL - should fail
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `7200`,
        },
      })

      expect(response.status).toBe(409)
    })
  })

  // ============================================================================
  // HEAD Metadata Edge Cases
  // ============================================================================

  describe(`HEAD Metadata Edge Cases`, () => {
    test(`should return TTL metadata if configured`, async () => {
      const streamPath = `/v1/stream/head-ttl-metadata-test-${Date.now()}`

      // Create with TTL
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `3600`,
        },
      })

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })

      // SHOULD return TTL metadata
      const ttl = response.headers.get(`Stream-TTL`)
      if (ttl) {
        expect(parseInt(ttl)).toBeGreaterThan(0)
        expect(parseInt(ttl)).toBeLessThanOrEqual(3600)
      }
    })

    test(`should return Expires-At metadata if configured`, async () => {
      const streamPath = `/v1/stream/head-expires-metadata-test-${Date.now()}`

      const expiresAt = new Date(Date.now() + 3600000).toISOString()

      // Create with Expires-At
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-Expires-At": expiresAt,
        },
      })

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })

      // SHOULD return Expires-At metadata
      const expiresHeader = response.headers.get(`Stream-Expires-At`)
      if (expiresHeader) {
        expect(expiresHeader).toBeDefined()
      }
    })
  })

  // ============================================================================
  // TTL Expiration Behavior Tests
  // ============================================================================

  describe(`TTL Expiration Behavior`, () => {
    // Helper function to wait for a specified duration
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))

    // Helper to generate unique stream paths for concurrent tests
    const uniquePath = (prefix: string) =>
      `/v1/stream/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`

    // Run tests concurrently to avoid 6x 1.5s wait time
    test.concurrent(`should return 404 on HEAD after TTL expires`, async () => {
      const streamPath = uniquePath(`ttl-expire-head`)

      // Create stream with 1 second TTL
      const createResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `1`,
        },
      })
      expect(createResponse.status).toBe(201)

      // Verify stream exists immediately
      const headBefore = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })
      expect(headBefore.status).toBe(200)

      // Wait for TTL to expire (1 second + buffer)
      await sleep(1500)

      // Stream should no longer exist
      const headAfter = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `HEAD`,
      })
      expect(headAfter.status).toBe(404)
    })

    test.concurrent(`should return 404 on GET after TTL expires`, async () => {
      const streamPath = uniquePath(`ttl-expire-get`)

      // Create stream with 1 second TTL and some data
      const createResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: {
          "Content-Type": `text/plain`,
          "Stream-TTL": `1`,
        },
        body: `test data`,
      })
      expect(createResponse.status).toBe(201)

      // Verify stream is readable immediately
      const getBefore = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      expect(getBefore.status).toBe(200)

      // Wait for TTL to expire
      await sleep(1500)

      // Stream should no longer exist
      const getAfter = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      expect(getAfter.status).toBe(404)
    })

    test.concurrent(
      `should return 404 on POST append after TTL expires`,
      async () => {
        const streamPath = uniquePath(`ttl-expire-post`)

        // Create stream with 1 second TTL
        const createResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: {
            "Content-Type": `text/plain`,
            "Stream-TTL": `1`,
          },
        })
        expect(createResponse.status).toBe(201)

        // Verify append works immediately
        const postBefore = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: `appended data`,
        })
        expect(postBefore.status).toBe(204)

        // Wait for TTL to expire
        await sleep(1500)

        // Append should fail - stream no longer exists
        const postAfter = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: `more data`,
        })
        expect(postAfter.status).toBe(404)
      }
    )

    test.concurrent(
      `should return 404 on HEAD after Expires-At passes`,
      async () => {
        const streamPath = uniquePath(`expires-at-head`)

        // Create stream that expires in 1 second
        const expiresAt = new Date(Date.now() + 1000).toISOString()
        const createResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: {
            "Content-Type": `text/plain`,
            "Stream-Expires-At": expiresAt,
          },
        })
        expect(createResponse.status).toBe(201)

        // Verify stream exists immediately
        const headBefore = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `HEAD`,
        })
        expect(headBefore.status).toBe(200)

        // Wait for expiry time to pass
        await sleep(1500)

        // Stream should no longer exist
        const headAfter = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `HEAD`,
        })
        expect(headAfter.status).toBe(404)
      }
    )

    test.concurrent(
      `should return 404 on GET after Expires-At passes`,
      async () => {
        const streamPath = uniquePath(`expires-at-get`)

        // Create stream that expires in 1 second
        const expiresAt = new Date(Date.now() + 1000).toISOString()
        const createResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: {
            "Content-Type": `text/plain`,
            "Stream-Expires-At": expiresAt,
          },
          body: `test data`,
        })
        expect(createResponse.status).toBe(201)

        // Verify stream is readable immediately
        const getBefore = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `GET`,
        })
        expect(getBefore.status).toBe(200)

        // Wait for expiry time to pass
        await sleep(1500)

        // Stream should no longer exist
        const getAfter = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `GET`,
        })
        expect(getAfter.status).toBe(404)
      }
    )

    test.concurrent(
      `should return 404 on POST append after Expires-At passes`,
      async () => {
        const streamPath = uniquePath(`expires-at-post`)

        // Create stream that expires in 1 second
        const expiresAt = new Date(Date.now() + 1000).toISOString()
        const createResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: {
            "Content-Type": `text/plain`,
            "Stream-Expires-At": expiresAt,
          },
        })
        expect(createResponse.status).toBe(201)

        // Verify append works immediately
        const postBefore = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: `appended data`,
        })
        expect(postBefore.status).toBe(204)

        // Wait for expiry time to pass
        await sleep(1500)

        // Append should fail - stream no longer exists
        const postAfter = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: `more data`,
        })
        expect(postAfter.status).toBe(404)
      }
    )

    test.concurrent(
      `should allow recreating stream after TTL expires`,
      async () => {
        const streamPath = uniquePath(`ttl-recreate`)

        // Create stream with 1 second TTL
        const createResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: {
            "Content-Type": `text/plain`,
            "Stream-TTL": `1`,
          },
          body: `original data`,
        })
        expect(createResponse.status).toBe(201)

        // Wait for TTL to expire
        await sleep(1500)

        // Recreate stream with different config - should succeed (201)
        const recreateResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: {
            "Content-Type": `application/json`,
            "Stream-TTL": `3600`,
          },
          body: `["new data"]`,
        })
        expect(recreateResponse.status).toBe(201)

        // Verify the new stream is accessible
        const getResponse = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `GET`,
        })
        expect(getResponse.status).toBe(200)
        const body = await getResponse.text()
        expect(body).toContain(`new data`)
      }
    )
  })

  // ============================================================================
  // Caching and ETag Tests
  // ============================================================================

  describe(`Caching and ETag`, () => {
    test(`should generate ETag on GET responses`, async () => {
      const streamPath = `/v1/stream/etag-generate-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      expect(response.status).toBe(200)
      const etag = response.headers.get(`etag`)
      expect(etag).toBeDefined()
      expect(etag!.length).toBeGreaterThan(0)
    })

    test(`should return 304 Not Modified for matching If-None-Match`, async () => {
      const streamPath = `/v1/stream/etag-304-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // First request to get ETag
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      const etag = response1.headers.get(`etag`)
      expect(etag).toBeDefined()

      // Second request with If-None-Match - MUST return 304
      const response2 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
        headers: {
          "If-None-Match": etag!,
        },
      })

      expect(response2.status).toBe(304)
      // 304 should have empty body
      const text = await response2.text()
      expect(text).toBe(``)
    })

    test(`should return 200 for non-matching If-None-Match`, async () => {
      const streamPath = `/v1/stream/etag-mismatch-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Request with wrong ETag - should return 200 with data
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
        headers: {
          "If-None-Match": `"wrong-etag"`,
        },
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toBe(`test data`)
    })

    test(`should return new ETag after data changes`, async () => {
      const streamPath = `/v1/stream/etag-change-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `initial`,
      })

      // Get initial ETag
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const etag1 = response1.headers.get(`etag`)

      // Append more data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: ` more`,
      })

      // Get new ETag
      const response2 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const etag2 = response2.headers.get(`etag`)

      // ETags should be different
      expect(etag1).not.toBe(etag2)

      // Old ETag should now return 200 (not 304)
      const response3 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
        headers: {
          "If-None-Match": etag1!,
        },
      })
      expect(response3.status).toBe(200)
    })
  })

  // ============================================================================
  // Chunking and Large Payloads
  // ============================================================================

  describe(`Chunking and Large Payloads`, () => {
    test(`should handle chunk-size pagination correctly`, async () => {
      const streamPath = `/v1/stream/chunk-pagination-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/octet-stream` },
      })

      // Append a large amount of data (100KB)
      const largeData = new Uint8Array(100 * 1024)
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256
      }

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/octet-stream` },
        body: largeData,
      })

      // Read back using pagination
      const accumulated: Array<number> = []
      let currentOffset: string | null = null
      let previousOffset: string | null = null
      let iterations = 0
      const maxIterations = 1000

      while (iterations < maxIterations) {
        iterations++

        const url: string = currentOffset
          ? `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(currentOffset)}`
          : `${getBaseUrl()}${streamPath}`

        const response: Response = await fetch(url, { method: `GET` })
        expect(response.status).toBe(200)

        const buffer = await response.arrayBuffer()
        const data = new Uint8Array(buffer)

        if (data.length > 0) {
          accumulated.push(...Array.from(data))
        }

        const nextOffset: string | null =
          response.headers.get(STREAM_OFFSET_HEADER)
        const upToDate = response.headers.get(STREAM_UP_TO_DATE_HEADER)

        if (upToDate === `true` && data.length === 0) {
          break
        }

        expect(nextOffset).toBeDefined()

        // Verify offset progresses
        if (nextOffset === currentOffset && data.length === 0) {
          break
        }

        // Verify monotonic progression
        if (previousOffset && nextOffset) {
          expect(nextOffset >= previousOffset).toBe(true)
        }

        previousOffset = currentOffset
        currentOffset = nextOffset
      }

      // Verify we got all the data
      const result = new Uint8Array(accumulated)
      expect(result.length).toBe(largeData.length)
      for (let i = 0; i < largeData.length; i++) {
        expect(result[i]).toBe(largeData[i])
      }
    })

    test(`should handle large payload appropriately`, async () => {
      const streamPath = `/v1/stream/large-payload-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/octet-stream` },
      })

      // Try to append very large payload (10MB)
      const largeData = new Uint8Array(10 * 1024 * 1024)

      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/octet-stream` },
        body: largeData,
      })

      // Server may accept it (200/204) or reject with 413
      expect([200, 204, 413]).toContain(response.status)
    }, 30000)
  })

  // ============================================================================
  // Read-Your-Writes Consistency
  // ============================================================================

  describe(`Read-Your-Writes Consistency`, () => {
    test(`should immediately read message after append`, async () => {
      const streamPath = `/v1/stream/ryw-test-${Date.now()}`

      // Create stream and append
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `initial`,
      })

      // Immediately read - should see the data
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      const text = await response.text()
      expect(text).toBe(`initial`)
    })

    test(`should immediately read multiple appends`, async () => {
      const streamPath = `/v1/stream/ryw-multi-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append multiple messages
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `msg1`,
      })

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `msg2`,
      })

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `msg3`,
      })

      // Immediately read - should see all messages
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      const text = await response.text()
      expect(text).toBe(`msg1msg2msg3`)
    })

    test(`should serve offset-based reads immediately after append`, async () => {
      const streamPath = `/v1/stream/ryw-offset-test-${Date.now()}`

      // Create stream with first message
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `first`,
      })

      // Get offset
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })
      const offset1 = response1.headers.get(STREAM_OFFSET_HEADER)!

      // Append more messages immediately
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `second`,
      })

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `third`,
      })

      // Immediately read from offset1 - should see second and third
      const response2 = await fetch(
        `${getBaseUrl()}${streamPath}?offset=${offset1}`,
        {
          method: `GET`,
        }
      )

      const text = await response2.text()
      expect(text).toBe(`secondthird`)
    })
  })

  // ============================================================================
  // SSE (Server-Sent Events) Mode
  // ============================================================================

  describe(`SSE Mode`, () => {
    test(`should return text/event-stream content-type for SSE requests`, async () => {
      const streamPath = `/v1/stream/sse-content-type-test-${Date.now()}`

      // Create stream with text/plain content type
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Make SSE request with AbortController to avoid hanging
      const { response } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { headers: { Accept: `text/event-stream` }, maxChunks: 0 }
      )

      expect(response.status).toBe(200)
      expect(response.headers.get(`content-type`)).toBe(`text/event-stream`)
    })

    test(`should accept live=sse query parameter for application/json`, async () => {
      const streamPath = `/v1/stream/sse-json-test-${Date.now()}`

      // Create stream with application/json content type
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({ message: `hello` }),
      })

      const { response } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { headers: { Accept: `text/event-stream` }, maxChunks: 0 }
      )

      expect(response.status).toBe(200)
      expect(response.headers.get(`content-type`)).toBe(`text/event-stream`)
    })

    test(`should require offset parameter for SSE mode`, async () => {
      const streamPath = `/v1/stream/sse-no-offset-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // SSE without offset should fail (similar to long-poll)
      const response = await fetch(`${getBaseUrl()}${streamPath}?live=sse`, {
        method: `GET`,
      })

      // Should return 400 (offset required for live modes)
      expect(response.status).toBe(400)
    })

    test(`client should reject SSE mode for incompatible content types`, async () => {
      const streamPath = `/v1/stream/sse-binary-test-${Date.now()}`

      // Create stream with binary content type (not SSE compatible)
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/octet-stream`,
      })

      // Append some binary data
      await stream.append(new Uint8Array([0x01, 0x02, 0x03]))

      // Trying to read via SSE mode should throw
      await expect(stream.stream({ live: `sse` })).rejects.toThrow()
    })

    test(`should stream data events via SSE`, async () => {
      const streamPath = `/v1/stream/sse-data-stream-test-${Date.now()}`

      // Create stream with text/plain content type
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `message one`,
      })

      // Append more data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `message two`,
      })

      // Make SSE request and read the response body
      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `message two` }
      )

      expect(response.status).toBe(200)

      // Verify SSE format: should contain event: and data: lines
      expect(received).toContain(`event:`)
      expect(received).toContain(`data:`)
    })

    test(`should send control events with offset`, async () => {
      const streamPath = `/v1/stream/sse-control-event-test-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Make SSE request
      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response.status).toBe(200)

      // Verify control event format (Protocol Section 5.7)
      expect(received).toContain(`event: control`)
      expect(received).toContain(`streamNextOffset`)
    })

    test(`should generate streamCursor in SSE control events`, async () => {
      const streamPath = `/v1/stream/sse-cursor-gen-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // SSE request without cursor - server MUST generate one
      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `streamCursor` }
      )

      expect(response.status).toBe(200)

      // Parse control event to find streamCursor
      const controlMatch = received.match(/event: control\s*\ndata: ({[^}]+})/)
      expect(controlMatch).toBeDefined()

      const controlData = JSON.parse(controlMatch![1] as string)
      expect(controlData.streamCursor).toBeDefined()

      // Cursor must be a numeric string (interval number)
      expect(/^\d+$/.test(controlData.streamCursor)).toBe(true)
    })

    test(`should handle cursor collision with jitter in SSE mode`, async () => {
      const streamPath = `/v1/stream/sse-cursor-collision-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // First SSE request to get current cursor
      const { received: received1 } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `streamCursor` }
      )

      const controlMatch1 = received1.match(
        /event: control\s*\ndata: ({[^}]+})/
      )
      expect(controlMatch1).toBeDefined()
      const cursor1 = JSON.parse(controlMatch1![1] as string).streamCursor

      // Second SSE request with same cursor - should get advanced cursor
      const { received: received2 } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse&cursor=${cursor1}`,
        { untilContent: `streamCursor` }
      )

      const controlMatch2 = received2.match(
        /event: control\s*\ndata: ({[^}]+})/
      )
      expect(controlMatch2).toBeDefined()
      const cursor2 = JSON.parse(controlMatch2![1] as string).streamCursor

      // The returned cursor MUST be strictly greater than the one we sent
      // (monotonic progression prevents cache cycles)
      expect(parseInt(cursor2 as string, 10)).toBeGreaterThan(
        parseInt(cursor1 as string, 10)
      )
    })

    test(`should wrap JSON data in arrays for SSE and produce valid JSON`, async () => {
      const streamPath = `/v1/stream/sse-json-wrap-test-${Date.now()}`

      // Create JSON stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({ id: 1, message: `hello` }),
      })

      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: data` }
      )

      expect(response.status).toBe(200)
      expect(received).toContain(`event: data`)

      // Parse SSE events properly (handles multi-line data per SSE spec)
      const events = parseSSEEvents(received)
      const dataEvent = events.find((e) => e.type === `data`)
      expect(dataEvent).toBeDefined()

      // This will throw if JSON is invalid (e.g., trailing comma)
      const parsed = JSON.parse(dataEvent!.data)

      // Verify the structure matches what we sent
      expect(parsed).toEqual([{ id: 1, message: `hello` }])
    })

    test(`should handle SSE for empty stream with correct offset`, async () => {
      const streamPath = `/v1/stream/sse-empty-test-${Date.now()}`

      // Create empty stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // First, get the offset from HTTP GET (the canonical source)
      const httpResponse = await fetch(`${getBaseUrl()}${streamPath}`)
      const httpOffset = httpResponse.headers.get(`Stream-Next-Offset`)
      expect(httpOffset).toBeDefined()
      expect(httpOffset).not.toBe(`-1`) // Should be the stream's actual offset, not -1

      // Make SSE request
      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )
      expect(response.status).toBe(200)

      // Should get a control event even for empty stream
      expect(received).toContain(`event: control`)

      // Parse the control event and verify offset matches HTTP GET
      const controlLine = received
        .split(`\n`)
        .find((l) => l.startsWith(`data: `) && l.includes(`streamNextOffset`))
      expect(controlLine).toBeDefined()

      const controlPayload = controlLine!.slice(`data: `.length)
      const controlData = JSON.parse(controlPayload)

      // SSE control offset should match HTTP GET offset (not -1)
      expect(controlData[`streamNextOffset`]).toBe(httpOffset)
    })

    test(`should send upToDate flag in SSE control events when caught up`, async () => {
      const streamPath = `/v1/stream/sse-uptodate-test-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Make SSE request and read until we get a control event
      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `"upToDate"` }
      )

      expect(response.status).toBe(200)

      // Parse the control event
      const controlLine = received
        .split(`\n`)
        .find((l) => l.startsWith(`data: `) && l.includes(`streamNextOffset`))
      expect(controlLine).toBeDefined()

      const controlPayload = controlLine!.slice(`data: `.length)
      const controlData = JSON.parse(controlPayload)

      // When client has read all data, server MUST include upToDate: true
      // This is essential for clients to know they've caught up to head
      expect(controlData.upToDate).toBe(true)
    })

    test(`should have correct SSE headers (no Content-Length, proper Cache-Control)`, async () => {
      const streamPath = `/v1/stream/sse-headers-test-${Date.now()}`

      // Create stream with data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Make SSE request
      const { response } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `test data` }
      )

      expect(response.status).toBe(200)

      // SSE MUST have text/event-stream content type
      expect(response.headers.get(`content-type`)).toBe(`text/event-stream`)

      // SSE MUST NOT have Content-Length (it's a streaming response)
      expect(response.headers.get(`content-length`)).toBeNull()

      // SSE SHOULD have Cache-Control: no-cache to prevent proxy buffering
      const cacheControl = response.headers.get(`cache-control`)
      expect(cacheControl).toContain(`no-cache`)
    })

    test(`should handle newlines in text/plain payloads`, async () => {
      const streamPath = `/v1/stream/sse-newline-test-${Date.now()}`

      // Create stream with text containing newlines
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `line1\nline2\nline3`,
      })

      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response.status).toBe(200)
      expect(received).toContain(`event: data`)

      // Per SSE spec, multiline data must use multiple "data:" lines
      // Each line should have its own data: prefix
      expect(received).toContain(`data: line1`)
      expect(received).toContain(`data: line2`)
      expect(received).toContain(`data: line3`)
    })

    test(`should prevent CRLF injection in payloads - embedded event boundaries become literal data`, async () => {
      const streamPath = `/v1/stream/sse-crlf-injection-test-${Date.now()}`

      // Payload attempts to inject a fake control event via CRLF sequences
      // If vulnerable, this would terminate the current event and inject a new one
      const maliciousPayload = `safe content\r\n\r\nevent: control\r\ndata: {"injected":true}\r\n\r\nmore safe content`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: maliciousPayload,
      })

      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response.status).toBe(200)

      // Parse all events from the response
      const events = parseSSEEvents(received)

      // Should have exactly 1 data event and 1 control event (the real one from server)
      const dataEvents = events.filter((e) => e.type === `data`)
      const controlEvents = events.filter((e) => e.type === `control`)

      expect(dataEvents.length).toBe(1)
      expect(controlEvents.length).toBe(1)

      // The "injected" control event should NOT exist as a real event
      // Instead, "event: control" should appear as literal text within the data
      const dataContent = dataEvents[0]!.data
      expect(dataContent).toContain(`event: control`)
      expect(dataContent).toContain(`data: {"injected":true}`)

      // The real control event should have server-generated fields, not injected ones
      const controlContent = JSON.parse(controlEvents[0]!.data)
      expect(controlContent.injected).toBeUndefined()
      expect(controlContent.streamNextOffset).toBeDefined()
    })

    test(`should prevent CRLF injection - LF-only attack vectors`, async () => {
      const streamPath = `/v1/stream/sse-lf-injection-test-${Date.now()}`

      // Attempt injection using Unix-style line endings only
      const maliciousPayload = `start\n\nevent: data\ndata: fake-event\n\nend`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: maliciousPayload,
      })

      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response.status).toBe(200)

      const events = parseSSEEvents(received)
      const dataEvents = events.filter((e) => e.type === `data`)

      // Should be exactly 1 data event (the injected one should be escaped)
      expect(dataEvents.length).toBe(1)

      // The payload should be preserved as literal content, including the
      // "event: data" and "data: fake-event" as text, not parsed as SSE commands
      const dataContent = dataEvents[0]!.data
      expect(dataContent).toContain(`event: data`)
      expect(dataContent).toContain(`data: fake-event`)
    })

    test(`should prevent CRLF injection - carriage return only attack vectors`, async () => {
      const streamPath = `/v1/stream/sse-cr-injection-test-${Date.now()}`

      // Attempt injection using CR-only line endings (per SSE spec, CR is a valid line terminator)
      const maliciousPayload = `start\r\revent: control\rdata: {"cr_injected":true}\r\rend`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: maliciousPayload,
      })

      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response.status).toBe(200)

      const events = parseSSEEvents(received)
      const controlEvents = events.filter((e) => e.type === `control`)

      // Should have exactly 1 control event (the real one from server)
      expect(controlEvents.length).toBe(1)

      // The real control event should not contain injected fields
      const controlContent = JSON.parse(controlEvents[0]!.data)
      expect(controlContent.cr_injected).toBeUndefined()
      expect(controlContent.streamNextOffset).toBeDefined()
    })

    test(`should handle JSON payloads with embedded newlines safely`, async () => {
      const streamPath = `/v1/stream/sse-json-newline-test-${Date.now()}`

      // JSON content that contains literal newlines in string values
      // These should be JSON-escaped, but we test that even if they're not,
      // SSE encoding handles them safely
      const jsonPayload = JSON.stringify({
        message: `line1\nline2\nline3`,
        attack: `try\r\n\r\nevent: control\r\ndata: {"bad":true}`,
      })

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
        body: jsonPayload,
      })

      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response.status).toBe(200)

      const events = parseSSEEvents(received)
      const dataEvents = events.filter((e) => e.type === `data`)
      const controlEvents = events.filter((e) => e.type === `control`)

      expect(dataEvents.length).toBe(1)
      expect(controlEvents.length).toBe(1)

      // Parse the data event - should be valid JSON array wrapping the original object
      const parsedData = JSON.parse(dataEvents[0]!.data)
      expect(Array.isArray(parsedData)).toBe(true)
      expect(parsedData[0].message).toBe(`line1\nline2\nline3`)
      expect(parsedData[0].attack).toContain(`event: control`)

      // Control event should be the real server-generated one
      const controlContent = JSON.parse(controlEvents[0]!.data)
      expect(controlContent.bad).toBeUndefined()
      expect(controlContent.streamNextOffset).toBeDefined()
    })

    test(`should generate unique, monotonically increasing offsets in SSE mode`, async () => {
      const streamPath = `/v1/stream/sse-monotonic-offset-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append multiple messages
      for (let i = 0; i < 5; i++) {
        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: `message ${i}`,
        })
      }

      // Make SSE request
      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response.status).toBe(200)

      // Extract all control event offsets
      const controlLines = received
        .split(`\n`)
        .filter((l) => l.startsWith(`data: `) && l.includes(`streamNextOffset`))

      const offsets: Array<string> = []
      for (const line of controlLines) {
        const payload = line.slice(`data: `.length)
        const data = JSON.parse(payload)
        offsets.push(data[`streamNextOffset`])
      }

      // Verify offsets are unique and strictly increasing (lexicographically)
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]! > offsets[i - 1]!).toBe(true)
      }
    })

    test(`should support reconnection with last known offset`, async () => {
      const streamPath = `/v1/stream/sse-reconnect-test-${Date.now()}`

      // Create stream with initial data
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `message 1`,
      })

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `message 2`,
      })

      // First SSE connection - get initial data and offset
      let lastOffset: string | null = null
      const { response: response1, received: received1 } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse`,
        { untilContent: `event: control` }
      )

      expect(response1.status).toBe(200)

      // Extract offset from control event
      const controlLine = received1
        .split(`\n`)
        .find((l) => l.startsWith(`data: `) && l.includes(`streamNextOffset`))
      const controlPayload = controlLine!.slice(`data: `.length)
      lastOffset = JSON.parse(controlPayload)[`streamNextOffset`]

      expect(lastOffset).toBeDefined()

      // Append more data while "disconnected"
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `message 3`,
      })

      // Reconnect with last known offset
      const { response: response2, received: received2 } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=${lastOffset}&live=sse`,
        { untilContent: `message 3` }
      )

      expect(response2.status).toBe(200)

      // Should receive message 3 (the new one), not duplicates of 1 and 2
      expect(received2).toContain(`message 3`)
      // Should NOT contain message 1 or 2 (already received before disconnect)
      expect(received2).not.toContain(`message 1`)
      expect(received2).not.toContain(`message 2`)
    })
  })

  // ============================================================================
  // JSON Mode
  // ============================================================================

  describe(`JSON Mode`, () => {
    test(`should allow PUT with empty array body (creates empty stream)`, async () => {
      const streamPath = `/v1/stream/json-put-empty-array-test-${Date.now()}`

      // PUT with empty array should create an empty stream
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
        body: `[]`,
      })

      expect(response.status).toBe(201)

      // Reading should return empty array
      const readResponse = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await readResponse.json()
      expect(data).toEqual([])
      expect(readResponse.headers.get(STREAM_UP_TO_DATE_HEADER)).toBe(`true`)
    })

    test(`should reject POST with empty array body`, async () => {
      const streamPath = `/v1/stream/json-post-empty-array-test-${Date.now()}`

      // Create stream first
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })

      // POST with empty array should be rejected
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `[]`,
      })

      expect(response.status).toBe(400)
    })

    test(`should handle content-type with charset parameter`, async () => {
      const streamPath = `/v1/stream/json-charset-test-${Date.now()}`

      // Create with charset parameter
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json; charset=utf-8` },
      })

      // Append JSON
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json; charset=utf-8` },
        body: JSON.stringify({ message: `hello` }),
      })

      // Read and verify it's treated as JSON mode
      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      expect(Array.isArray(data)).toBe(true)
      expect(data).toEqual([{ message: `hello` }])
    })

    test(`should wrap single JSON value in array`, async () => {
      const streamPath = `/v1/stream/json-single-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      await stream.append({ message: `hello` })

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      expect(Array.isArray(data)).toBe(true)
      expect(data).toEqual([{ message: `hello` }])
    })

    test(`should store arrays as single messages`, async () => {
      const streamPath = `/v1/stream/json-array-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      // Append array - should be stored as ONE message containing the array
      await stream.append([{ id: 1 }, { id: 2 }, { id: 3 }])

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      expect(Array.isArray(data)).toBe(true)
      expect(data).toEqual([[{ id: 1 }, { id: 2 }, { id: 3 }]])
    })

    test(`should concatenate multiple appends into single array`, async () => {
      const streamPath = `/v1/stream/json-concat-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      await stream.append({ event: `first` })
      await stream.append({ event: `second` })
      await stream.append({ event: `third` })

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      expect(Array.isArray(data)).toBe(true)
      expect(data).toEqual([
        { event: `first` },
        { event: `second` },
        { event: `third` },
      ])
    })

    test(`should handle mixed single values and arrays`, async () => {
      const streamPath = `/v1/stream/json-mixed-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      await stream.append({ type: `single` })
      await stream.append([
        { type: `array`, id: 1 },
        { type: `array`, id: 2 },
      ])
      await stream.append({ type: `single-again` })

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      // Array is stored as ONE message
      expect(data).toEqual([
        { type: `single` },
        [
          { type: `array`, id: 1 },
          { type: `array`, id: 2 },
        ],
        { type: `single-again` },
      ])
    })

    test(`should reject invalid JSON with 400`, async () => {
      const streamPath = `/v1/stream/json-invalid-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })

      // Try to append invalid JSON
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{ invalid json }`,
      })

      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
    })

    test(`should handle various JSON value types`, async () => {
      const streamPath = `/v1/stream/json-types-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      await stream.append(`string value`)
      await stream.append(42)
      await stream.append(true)
      await stream.append(null)
      await stream.append({ object: `value` })
      await stream.append([1, 2, 3])

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      expect(data).toEqual([
        `string value`,
        42,
        true,
        null,
        { object: `value` },
        [1, 2, 3],
      ])
    })

    test(`should preserve JSON structure and nesting`, async () => {
      const streamPath = `/v1/stream/json-nested-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      await stream.append({
        user: {
          id: 123,
          name: `Alice`,
          tags: [`admin`, `verified`],
        },
        timestamp: `2024-01-01T00:00:00Z`,
      })

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      expect(data).toEqual([
        {
          user: {
            id: 123,
            name: `Alice`,
            tags: [`admin`, `verified`],
          },
          timestamp: `2024-01-01T00:00:00Z`,
        },
      ])
    })

    test(`should work with client json() iterator`, async () => {
      const streamPath = `/v1/stream/json-iterator-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      await stream.append({ id: 1 })
      await stream.append({ id: 2 })
      await stream.append({ id: 3 })

      const res = await stream.stream<{ id: number }>({ live: false })
      const items = await res.json()

      // All three objects are batched together by the writer
      expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    })

    test(`should reject empty JSON arrays with 400`, async () => {
      const streamPath = `/v1/stream/json-empty-array-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })

      // Try to append empty array
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `[]`,
      })

      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
    })

    test(`should store nested arrays as single messages`, async () => {
      const streamPath = `/v1/stream/json-nested-arrays-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      // Append nested array - stored as ONE message
      await stream.append([
        [1, 2],
        [3, 4],
      ])

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      // Should store 1 message containing the nested array
      expect(data).toEqual([
        [
          [1, 2],
          [3, 4],
        ],
      ])
    })

    test(`should store arrays as values when double-wrapped`, async () => {
      const streamPath = `/v1/stream/json-wrapped-array-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      // Append double-wrapped array - stored as ONE message containing the array
      await stream.append([[1, 2, 3]])

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      // Should store 1 message containing the single-wrapped array
      expect(data).toEqual([[[1, 2, 3]]])
      expect(data.length).toBe(1)
    })

    test(`should store primitive arrays as single messages`, async () => {
      const streamPath = `/v1/stream/json-primitive-array-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      // Each append stores ONE message
      await stream.append([1, 2, 3])
      await stream.append([`a`, `b`, `c`])

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      // Should store 2 messages (2 arrays)
      expect(data).toEqual([
        [1, 2, 3],
        [`a`, `b`, `c`],
      ])
    })

    test(`should handle mixed batching - single values, arrays, and nested arrays`, async () => {
      const streamPath = `/v1/stream/json-mixed-batching-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `application/json`,
      })

      await stream.append({ single: 1 }) // 1 message
      await stream.append([{ batch: 2 }, { batch: 3 }]) // 1 message (array)
      await stream.append([[`nested`, `array`]]) // 1 message (nested array)
      await stream.append(42) // 1 message

      const response = await fetch(`${getBaseUrl()}${streamPath}`)
      const data = await response.json()

      expect(data).toEqual([
        { single: 1 },
        [{ batch: 2 }, { batch: 3 }],
        [[`nested`, `array`]],
        42,
      ])
      expect(data.length).toBe(4)
    })
  })

  // ============================================================================
  // Property-Based Tests (fast-check)
  // ============================================================================

  describe(`Property-Based Tests (fast-check)`, () => {
    describe(`Byte-Exactness Property`, () => {
      test(`arbitrary byte sequences are preserved exactly`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate 1-10 chunks of arbitrary bytes (1-500 bytes each)
            fc.array(fc.uint8Array({ minLength: 1, maxLength: 500 }), {
              minLength: 1,
              maxLength: 10,
            }),
            async (chunks) => {
              const streamPath = `/v1/stream/fc-byte-exactness-${Date.now()}-${Math.random().toString(36).slice(2)}`

              // Create stream
              const createResponse = await fetch(
                `${getBaseUrl()}${streamPath}`,
                {
                  method: `PUT`,
                  headers: { "Content-Type": `application/octet-stream` },
                }
              )
              expect([200, 201, 204]).toContain(createResponse.status)

              // Append each chunk
              for (const chunk of chunks) {
                const response = await fetch(`${getBaseUrl()}${streamPath}`, {
                  method: `POST`,
                  headers: { "Content-Type": `application/octet-stream` },
                  body: chunk,
                })
                expect(response.status).toBe(204)
              }

              // Calculate expected result
              const totalLength = chunks.reduce(
                (sum, chunk) => sum + chunk.length,
                0
              )
              const expected = new Uint8Array(totalLength)
              let offset = 0
              for (const chunk of chunks) {
                expected.set(chunk, offset)
                offset += chunk.length
              }

              // Read back entire stream
              const accumulated: Array<number> = []
              let currentOffset: string | null = null
              let iterations = 0

              while (iterations < 100) {
                iterations++

                const url: string = currentOffset
                  ? `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(currentOffset)}`
                  : `${getBaseUrl()}${streamPath}`

                const response: Response = await fetch(url, { method: `GET` })
                expect(response.status).toBe(200)

                const buffer = await response.arrayBuffer()
                const data = new Uint8Array(buffer)

                if (data.length > 0) {
                  accumulated.push(...Array.from(data))
                }

                const nextOffset: string | null =
                  response.headers.get(STREAM_OFFSET_HEADER)
                const upToDate = response.headers.get(STREAM_UP_TO_DATE_HEADER)

                if (upToDate === `true` && data.length === 0) {
                  break
                }

                if (nextOffset === currentOffset) {
                  break
                }

                currentOffset = nextOffset
              }

              // Verify byte-for-byte exactness
              const result = new Uint8Array(accumulated)
              expect(result.length).toBe(expected.length)
              for (let i = 0; i < expected.length; i++) {
                expect(result[i]).toBe(expected[i])
              }

              return true
            }
          ),
          { numRuns: 20 } // Limit runs since each creates a stream
        )
      })

      test(`single byte values cover full range (0-255)`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate a byte value from 0-255
            fc.integer({ min: 0, max: 255 }),
            async (byteValue) => {
              const streamPath = `/v1/stream/fc-single-byte-${Date.now()}-${Math.random().toString(36).slice(2)}`

              // Create and append single byte
              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `application/octet-stream` },
              })

              const chunk = new Uint8Array([byteValue])
              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `POST`,
                headers: { "Content-Type": `application/octet-stream` },
                body: chunk,
              })

              // Read back
              const response = await fetch(`${getBaseUrl()}${streamPath}`)
              const buffer = await response.arrayBuffer()
              const result = new Uint8Array(buffer)

              expect(result.length).toBe(1)
              expect(result[0]).toBe(byteValue)

              return true
            }
          ),
          { numRuns: 50 } // Test a good sample of byte values
        )
      })
    })

    describe(`Operation Sequence Properties`, () => {
      // Define operation types for the state machine
      type AppendOp = { type: `append`; data: Uint8Array }
      type ReadOp = { type: `read` }
      type ReadFromOffsetOp = { type: `readFromOffset`; offsetIndex: number }

      test(`random operation sequences maintain stream invariants`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate a sequence of operations
            fc.array(
              fc.oneof(
                // Append operation with random data
                fc
                  .uint8Array({ minLength: 1, maxLength: 200 })
                  .map((data): AppendOp => ({ type: `append`, data })),
                // Full read operation
                fc.constant<ReadOp>({ type: `read` }),
                // Read from a saved offset (index into saved offsets array)
                fc.integer({ min: 0, max: 20 }).map(
                  (idx): ReadFromOffsetOp => ({
                    type: `readFromOffset`,
                    offsetIndex: idx,
                  })
                )
              ),
              { minLength: 5, maxLength: 30 }
            ),
            async (operations) => {
              const streamPath = `/v1/stream/fc-ops-${Date.now()}-${Math.random().toString(36).slice(2)}`

              // Create stream
              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `application/octet-stream` },
              })

              // Track state
              const appendedData: Array<number> = []
              const savedOffsets: Array<string> = []

              for (const op of operations) {
                if (op.type === `append`) {
                  const response = await fetch(`${getBaseUrl()}${streamPath}`, {
                    method: `POST`,
                    headers: { "Content-Type": `application/octet-stream` },
                    body: op.data as BodyInit,
                  })
                  expect(response.status).toBe(204)

                  // Track what we appended
                  appendedData.push(...Array.from(op.data))

                  // Save the offset for potential later reads
                  const offset = response.headers.get(STREAM_OFFSET_HEADER)
                  if (offset) {
                    savedOffsets.push(offset)
                  }
                } else if (op.type === `read`) {
                  // Full read from beginning - verify all data
                  const accumulated: Array<number> = []
                  let currentOffset: string | null = null
                  let iterations = 0

                  while (iterations < 100) {
                    iterations++

                    const url: string = currentOffset
                      ? `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(currentOffset)}`
                      : `${getBaseUrl()}${streamPath}`

                    const response: Response = await fetch(url, {
                      method: `GET`,
                    })
                    const buffer = await response.arrayBuffer()
                    const data = new Uint8Array(buffer)

                    if (data.length > 0) {
                      accumulated.push(...Array.from(data))
                    }

                    const nextOffset: string | null =
                      response.headers.get(STREAM_OFFSET_HEADER)
                    const upToDate = response.headers.get(
                      STREAM_UP_TO_DATE_HEADER
                    )

                    if (upToDate === `true` && data.length === 0) {
                      break
                    }

                    if (nextOffset === currentOffset) {
                      break
                    }

                    currentOffset = nextOffset
                  }

                  // Verify we read exactly what was appended
                  expect(accumulated.length).toBe(appendedData.length)
                  for (let i = 0; i < appendedData.length; i++) {
                    expect(accumulated[i]).toBe(appendedData[i])
                  }
                } else {
                  // Read from a previously saved offset (op.type === `readFromOffset`)
                  if (savedOffsets.length === 0) {
                    continue // No offsets saved yet
                  }

                  const offsetIdx = op.offsetIndex % savedOffsets.length
                  const offset = savedOffsets[offsetIdx]!

                  const response = await fetch(
                    `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(offset)}`,
                    { method: `GET` }
                  )
                  expect(response.status).toBe(200)

                  // Verify offset is monotonically increasing
                  const nextOffset = response.headers.get(STREAM_OFFSET_HEADER)
                  if (nextOffset) {
                    // Offsets should be lexicographically greater or equal
                    expect(nextOffset >= offset).toBe(true)
                  }
                }
              }

              return true
            }
          ),
          { numRuns: 15 }
        )
      })

      test(`offsets are always monotonically increasing`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate multiple chunks to append
            fc.array(fc.uint8Array({ minLength: 1, maxLength: 100 }), {
              minLength: 2,
              maxLength: 15,
            }),
            async (chunks) => {
              const streamPath = `/v1/stream/fc-monotonic-${Date.now()}-${Math.random().toString(36).slice(2)}`

              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `application/octet-stream` },
              })

              const offsets: Array<string> = []

              // Append all chunks and collect offsets
              for (const chunk of chunks) {
                const response = await fetch(`${getBaseUrl()}${streamPath}`, {
                  method: `POST`,
                  headers: { "Content-Type": `application/octet-stream` },
                  body: chunk,
                })

                const offset = response.headers.get(STREAM_OFFSET_HEADER)
                expect(offset).toBeDefined()
                offsets.push(offset!)
              }

              // Verify offsets are strictly increasing (lexicographically)
              for (let i = 1; i < offsets.length; i++) {
                expect(offsets[i]! > offsets[i - 1]!).toBe(true)
              }

              return true
            }
          ),
          { numRuns: 25 }
        )
      })

      test(`read-your-writes: data is immediately visible after append`, async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.uint8Array({ minLength: 1, maxLength: 500 }),
            async (data) => {
              const streamPath = `/v1/stream/fc-ryw-${Date.now()}-${Math.random().toString(36).slice(2)}`

              // Create stream
              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `application/octet-stream` },
              })

              // Append data
              const appendResponse = await fetch(
                `${getBaseUrl()}${streamPath}`,
                {
                  method: `POST`,
                  headers: { "Content-Type": `application/octet-stream` },
                  body: data,
                }
              )
              expect(appendResponse.status).toBe(204)

              // Immediately read back
              const readResponse = await fetch(`${getBaseUrl()}${streamPath}`)
              expect(readResponse.status).toBe(200)

              const buffer = await readResponse.arrayBuffer()
              const result = new Uint8Array(buffer)

              // Must see the data we just wrote
              expect(result.length).toBe(data.length)
              for (let i = 0; i < data.length; i++) {
                expect(result[i]).toBe(data[i])
              }

              return true
            }
          ),
          { numRuns: 30 }
        )
      })
    })

    describe(`Immutability Properties`, () => {
      test(`data at offset never changes after additional appends`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Initial data and additional data to append
            fc.uint8Array({ minLength: 1, maxLength: 200 }),
            fc.array(fc.uint8Array({ minLength: 1, maxLength: 100 }), {
              minLength: 1,
              maxLength: 5,
            }),
            async (initialData, additionalChunks) => {
              const streamPath = `/v1/stream/fc-immutable-${Date.now()}-${Math.random().toString(36).slice(2)}`

              // Create and append initial data
              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `application/octet-stream` },
              })

              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `POST`,
                headers: { "Content-Type": `application/octet-stream` },
                body: initialData,
              })

              // Read and save the offset after initial data
              const initialRead = await fetch(`${getBaseUrl()}${streamPath}`)
              const initialBuffer = await initialRead.arrayBuffer()
              const initialResult = new Uint8Array(initialBuffer)

              // Append more data
              for (const chunk of additionalChunks) {
                await fetch(`${getBaseUrl()}${streamPath}`, {
                  method: `POST`,
                  headers: { "Content-Type": `application/octet-stream` },
                  body: chunk,
                })
              }

              // Read from beginning again - initial data should be unchanged
              const rereadResponse = await fetch(`${getBaseUrl()}${streamPath}`)
              const rereadBuffer = await rereadResponse.arrayBuffer()
              const rereadResult = new Uint8Array(rereadBuffer)

              // The initial data portion should be identical
              expect(rereadResult.length).toBeGreaterThanOrEqual(
                initialResult.length
              )
              for (let i = 0; i < initialResult.length; i++) {
                expect(rereadResult[i]).toBe(initialResult[i])
              }

              return true
            }
          ),
          { numRuns: 20 }
        )
      })
    })

    describe(`Offset Validation Properties`, () => {
      test(`should reject offsets with invalid characters`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate strings with at least one invalid character
            fc.oneof(
              // Strings with spaces
              fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${a} ${b}`),
              // Strings with path traversal
              fc.string().map((s) => `../${s}`),
              fc.string().map((s) => `${s}/..`),
              // Strings with null bytes
              fc.string().map((s) => `${s}\u0000`),
              // Strings with newlines
              fc.string().map((s) => `${s}\n`),
              fc.string().map((s) => `${s}\r\n`),
              // Strings with commas
              fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${a},${b}`),
              // Strings with slashes
              fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${a}/${b}`)
            ),
            async (badOffset) => {
              const streamPath = `/v1/stream/fc-bad-offset-${Date.now()}-${Math.random().toString(36).slice(2)}`

              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `text/plain` },
                body: `test`,
              })

              const response = await fetch(
                `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(badOffset)}`,
                { method: `GET` }
              )

              // Should reject with 400
              expect(response.status).toBe(400)

              return true
            }
          ),
          { numRuns: 30 }
        )
      })
    })

    describe(`Sequence Ordering Properties`, () => {
      test(`lexicographically ordered seq values are accepted`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate a sorted array of unique lexicographic strings
            fc
              .array(fc.stringMatching(/^[0-9a-zA-Z]+$/), {
                minLength: 2,
                maxLength: 10,
              })
              .map((arr) => [...new Set(arr)].sort())
              .filter((arr) => arr.length >= 2),
            async (seqValues) => {
              const streamPath = `/v1/stream/fc-seq-order-${Date.now()}-${Math.random().toString(36).slice(2)}`

              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `text/plain` },
              })

              // Append with each seq value in order
              for (const seq of seqValues) {
                const response = await fetch(`${getBaseUrl()}${streamPath}`, {
                  method: `POST`,
                  headers: {
                    "Content-Type": `text/plain`,
                    [STREAM_SEQ_HEADER]: seq,
                  },
                  body: `data-${seq}`,
                })
                expect(response.status).toBe(204)
              }

              return true
            }
          ),
          { numRuns: 20 }
        )
      })

      test(`out-of-order seq values are rejected`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate two strings where the first is lexicographically greater
            fc
              .tuple(
                fc.stringMatching(/^[0-9a-zA-Z]+$/),
                fc.stringMatching(/^[0-9a-zA-Z]+$/)
              )
              .filter(([a, b]) => a > b && a.length > 0 && b.length > 0),
            async ([firstSeq, secondSeq]) => {
              const streamPath = `/v1/stream/fc-seq-reject-${Date.now()}-${Math.random().toString(36).slice(2)}`

              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `text/plain` },
              })

              // First append with the larger seq value
              const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `POST`,
                headers: {
                  "Content-Type": `text/plain`,
                  [STREAM_SEQ_HEADER]: firstSeq,
                },
                body: `first`,
              })
              expect(response1.status).toBe(204)

              // Second append with smaller seq should be rejected
              const response2 = await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `POST`,
                headers: {
                  "Content-Type": `text/plain`,
                  [STREAM_SEQ_HEADER]: secondSeq,
                },
                body: `second`,
              })
              expect(response2.status).toBe(409)

              return true
            }
          ),
          { numRuns: 25 }
        )
      })
    })

    describe(`Concurrent Writer Stress Tests`, () => {
      test(`concurrent writers with sequence numbers - server handles gracefully`, async () => {
        const streamPath = `/v1/stream/concurrent-seq-${Date.now()}-${Math.random().toString(36).slice(2)}`

        // Create stream
        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: { "Content-Type": `text/plain` },
        })

        // Try to write with same seq from multiple "writers" concurrently
        const numWriters = 5
        const seqValue = `seq-001`

        const writePromises = Array.from({ length: numWriters }, (_, i) =>
          fetch(`${getBaseUrl()}${streamPath}`, {
            method: `POST`,
            headers: {
              "Content-Type": `text/plain`,
              [STREAM_SEQ_HEADER]: seqValue,
            },
            body: `writer-${i}`,
          })
        )

        const responses = await Promise.all(writePromises)
        const statuses = responses.map((r) => r.status)

        // Server should handle concurrent writes gracefully
        // All responses should be valid (success or conflict)
        for (const status of statuses) {
          expect([200, 204, 409]).toContain(status)
        }

        // At least one should succeed
        const successes = statuses.filter((s) => s === 200 || s === 204)
        expect(successes.length).toBeGreaterThanOrEqual(1)

        // Read back - should have exactly one write's data
        const readResponse = await fetch(`${getBaseUrl()}${streamPath}`)
        const content = await readResponse.text()

        // Content should contain data from exactly one writer
        const matchingWriters = Array.from({ length: numWriters }, (_, i) =>
          content.includes(`writer-${i}`)
        ).filter(Boolean)
        expect(matchingWriters.length).toBeGreaterThanOrEqual(1)
      })

      test(`concurrent writers racing with incrementing seq values`, async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 3, max: 8 }), // Number of writers
            async (numWriters) => {
              const streamPath = `/v1/stream/concurrent-race-${Date.now()}-${Math.random().toString(36).slice(2)}`

              // Create stream
              await fetch(`${getBaseUrl()}${streamPath}`, {
                method: `PUT`,
                headers: { "Content-Type": `text/plain` },
              })

              // Each writer gets a unique seq value (padded for lexicographic ordering)
              const writePromises = Array.from({ length: numWriters }, (_, i) =>
                fetch(`${getBaseUrl()}${streamPath}`, {
                  method: `POST`,
                  headers: {
                    "Content-Type": `text/plain`,
                    [STREAM_SEQ_HEADER]: String(i).padStart(4, `0`),
                  },
                  body: `data-${i}`,
                })
              )

              const responses = await Promise.all(writePromises)

              // With concurrent writes, some may succeed (200/204) and some may conflict (409)
              // due to out-of-order arrival at the server. All responses should be valid.
              const successIndices: Array<number> = []
              for (let i = 0; i < responses.length; i++) {
                expect([200, 204, 409]).toContain(responses[i]!.status)
                if (
                  responses[i]!.status === 200 ||
                  responses[i]!.status === 204
                ) {
                  successIndices.push(i)
                }
              }

              // At least one write should succeed
              expect(successIndices.length).toBeGreaterThanOrEqual(1)

              // Read back and verify successful writes are present
              const readResponse = await fetch(`${getBaseUrl()}${streamPath}`)
              const content = await readResponse.text()

              // All successful writes should have their data in the stream
              for (const i of successIndices) {
                expect(content).toContain(`data-${i}`)
              }

              return true
            }
          ),
          { numRuns: 10 }
        )
      })

      test(`concurrent appends without seq - all data is persisted`, async () => {
        const streamPath = `/v1/stream/concurrent-no-seq-${Date.now()}-${Math.random().toString(36).slice(2)}`

        // Create stream
        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: { "Content-Type": `text/plain` },
        })

        const numWriters = 10
        const writePromises = Array.from({ length: numWriters }, (_, i) =>
          fetch(`${getBaseUrl()}${streamPath}`, {
            method: `POST`,
            headers: { "Content-Type": `text/plain` },
            body: `concurrent-${i}`,
          })
        )

        const responses = await Promise.all(writePromises)

        // All should succeed
        for (const response of responses) {
          expect([200, 204]).toContain(response.status)
        }

        // All offsets that are returned should be valid (non-null)
        const offsets = responses.map((r) =>
          r.headers.get(STREAM_OFFSET_HEADER)
        )
        for (const offset of offsets) {
          expect(offset).not.toBeNull()
        }

        // Read back and verify all data is present (the key invariant)
        const readResponse = await fetch(`${getBaseUrl()}${streamPath}`)
        const content = await readResponse.text()

        for (let i = 0; i < numWriters; i++) {
          expect(content).toContain(`concurrent-${i}`)
        }
      })

      test(`mixed readers and writers - readers see consistent state`, async () => {
        const streamPath = `/v1/stream/concurrent-rw-${Date.now()}-${Math.random().toString(36).slice(2)}`

        // Create stream with initial data
        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: { "Content-Type": `text/plain` },
        })

        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: `initial`,
        })

        // Launch concurrent readers and writers
        const numOps = 20
        const operations = Array.from({ length: numOps }, (_, i) => {
          if (i % 2 === 0) {
            // Writer
            return fetch(`${getBaseUrl()}${streamPath}`, {
              method: `POST`,
              headers: { "Content-Type": `text/plain` },
              body: `write-${i}`,
            })
          } else {
            // Reader
            return fetch(`${getBaseUrl()}${streamPath}`)
          }
        })

        const responses = await Promise.all(operations)

        // All operations should succeed
        // Writers (even indices) return 204, readers (odd indices) return 200
        responses.forEach((response, i) => {
          const expectedStatus = i % 2 === 0 ? 204 : 200
          expect(response.status).toBe(expectedStatus)
        })

        // Final read should have all writes
        const finalRead = await fetch(`${getBaseUrl()}${streamPath}`)
        const content = await finalRead.text()

        // Initial data should be present
        expect(content).toContain(`initial`)

        // All writes should be present
        for (let i = 0; i < numOps; i += 2) {
          expect(content).toContain(`write-${i}`)
        }
      })
    })

    describe(`State Hash Verification`, () => {
      /**
       * Simple hash function for content verification.
       * Uses FNV-1a algorithm for deterministic hashing.
       */
      function hashContent(data: Uint8Array): string {
        let hash = 2166136261 // FNV offset basis
        for (const byte of data) {
          hash ^= byte
          hash = Math.imul(hash, 16777619) // FNV prime
          hash = hash >>> 0 // Convert to unsigned 32-bit
        }
        return hash.toString(16).padStart(8, `0`)
      }

      test(`replay produces identical content hash`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate a sequence of appends
            fc.array(fc.uint8Array({ minLength: 1, maxLength: 100 }), {
              minLength: 1,
              maxLength: 10,
            }),
            async (chunks) => {
              // Create first stream and append data
              const streamPath1 = `/v1/stream/hash-verify-1-${Date.now()}-${Math.random().toString(36).slice(2)}`
              await fetch(`${getBaseUrl()}${streamPath1}`, {
                method: `PUT`,
                headers: { "Content-Type": `application/octet-stream` },
              })

              for (const chunk of chunks) {
                await fetch(`${getBaseUrl()}${streamPath1}`, {
                  method: `POST`,
                  headers: { "Content-Type": `application/octet-stream` },
                  body: chunk,
                })
              }

              // Read and hash first stream
              const response1 = await fetch(`${getBaseUrl()}${streamPath1}`)
              const data1 = new Uint8Array(await response1.arrayBuffer())
              const hash1 = hashContent(data1)

              // Create second stream and replay same operations
              const streamPath2 = `/v1/stream/hash-verify-2-${Date.now()}-${Math.random().toString(36).slice(2)}`
              await fetch(`${getBaseUrl()}${streamPath2}`, {
                method: `PUT`,
                headers: { "Content-Type": `application/octet-stream` },
              })

              for (const chunk of chunks) {
                await fetch(`${getBaseUrl()}${streamPath2}`, {
                  method: `POST`,
                  headers: { "Content-Type": `application/octet-stream` },
                  body: chunk,
                })
              }

              // Read and hash second stream
              const response2 = await fetch(`${getBaseUrl()}${streamPath2}`)
              const data2 = new Uint8Array(await response2.arrayBuffer())
              const hash2 = hashContent(data2)

              // Hashes must match
              expect(hash1).toBe(hash2)
              expect(data1.length).toBe(data2.length)

              return true
            }
          ),
          { numRuns: 15 }
        )
      })

      test(`content hash changes with each append`, async () => {
        const streamPath = `/v1/stream/hash-changes-${Date.now()}-${Math.random().toString(36).slice(2)}`

        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `PUT`,
          headers: { "Content-Type": `application/octet-stream` },
        })

        const hashes: Array<string> = []

        // Append 5 chunks and verify hash changes each time
        for (let i = 0; i < 5; i++) {
          await fetch(`${getBaseUrl()}${streamPath}`, {
            method: `POST`,
            headers: { "Content-Type": `application/octet-stream` },
            body: new Uint8Array([i, i + 1, i + 2]),
          })

          const response = await fetch(`${getBaseUrl()}${streamPath}`)
          const data = new Uint8Array(await response.arrayBuffer())
          hashes.push(hashContent(data))
        }

        // All hashes should be unique
        const uniqueHashes = new Set(hashes)
        expect(uniqueHashes.size).toBe(5)
      })

      test(`empty stream has consistent hash`, async () => {
        // Create two empty streams
        const streamPath1 = `/v1/stream/empty-hash-1-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const streamPath2 = `/v1/stream/empty-hash-2-${Date.now()}-${Math.random().toString(36).slice(2)}`

        await fetch(`${getBaseUrl()}${streamPath1}`, {
          method: `PUT`,
          headers: { "Content-Type": `application/octet-stream` },
        })
        await fetch(`${getBaseUrl()}${streamPath2}`, {
          method: `PUT`,
          headers: { "Content-Type": `application/octet-stream` },
        })

        // Read both
        const response1 = await fetch(`${getBaseUrl()}${streamPath1}`)
        const response2 = await fetch(`${getBaseUrl()}${streamPath2}`)

        const data1 = new Uint8Array(await response1.arrayBuffer())
        const data2 = new Uint8Array(await response2.arrayBuffer())

        // Both should be empty and have same hash
        expect(data1.length).toBe(0)
        expect(data2.length).toBe(0)
        expect(hashContent(data1)).toBe(hashContent(data2))
      })

      test(`deterministic ordering - same data in same order produces same hash`, async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.uint8Array({ minLength: 1, maxLength: 50 }), {
              minLength: 2,
              maxLength: 5,
            }),
            async (chunks) => {
              // Create two streams with same data in same order
              const hashes: Array<string> = []

              for (let run = 0; run < 2; run++) {
                const streamPath = `/v1/stream/order-hash-${run}-${Date.now()}-${Math.random().toString(36).slice(2)}`

                await fetch(`${getBaseUrl()}${streamPath}`, {
                  method: `PUT`,
                  headers: { "Content-Type": `application/octet-stream` },
                })

                // Append in order
                for (const chunk of chunks) {
                  await fetch(`${getBaseUrl()}${streamPath}`, {
                    method: `POST`,
                    headers: { "Content-Type": `application/octet-stream` },
                    body: chunk,
                  })
                }

                const response = await fetch(`${getBaseUrl()}${streamPath}`)
                const data = new Uint8Array(await response.arrayBuffer())
                hashes.push(hashContent(data))
              }

              expect(hashes[0]).toBe(hashes[1])

              return true
            }
          ),
          { numRuns: 10 }
        )
      })
    })
  })
}

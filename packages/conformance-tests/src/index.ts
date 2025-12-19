/**
 * Conformance test suite for Durable Streams server implementations
 *
 * This package provides a standardized test suite that can be run against
 * any server implementation to verify protocol compliance.
 */

import { describe, expect, test } from "vitest"
import {
  DurableStream,
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "@durable-streams/client"

export interface ConformanceTestOptions {
  /** Base URL of the server to test */
  baseUrl: string
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
 * Run the full conformance test suite against a server
 */
export function runConformanceTests(options: ConformanceTestOptions): void {
  // Access options.baseUrl directly instead of destructuring to support
  // mutable config objects (needed for dynamic port assignment)
  const getBaseUrl = () => options.baseUrl

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
    test(`should wait for new data with long-poll`, async () => {
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
          const unsubscribe = res.subscribeBytes(async (chunk) => {
            if (chunk.data.length > 0) {
              receivedData.push(new TextDecoder().decode(chunk.data))
            }
            if (receivedData.length >= 1) {
              unsubscribe()
              res.cancel()
              resolve()
            }
          })
        })
      })()

      // Wait a bit for the long-poll to be active
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Append data while long-poll is waiting
      await stream.append(`new data`)

      await readPromise

      expect(receivedData).toContain(`new data`)
    }, 10000)

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
      expect([200, 204]).toContain(secondResponse.status)
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

      expect([200, 204]).toContain(response.status)
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

      expect([200, 204]).toContain(response.status)
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

      expect([200, 204]).toContain(response.status)
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
      expect([200, 204]).toContain(response2.status)
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

      expect([200, 204]).toContain(response.status)
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

      expect([200, 204]).toContain(response.status)
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
      expect(location).toBe(`${getBaseUrl()}${streamPath}`)
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
  // Killer Invariant Test
  // ============================================================================

  describe(`Byte-Exactness Invariant`, () => {
    test(`reading from offset repeatedly yields exact bytes appended`, async () => {
      const streamPath = `/v1/stream/killer-invariant-test-${Date.now()}`

      // Create stream
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/octet-stream` },
      })

      // Append random-sized chunks of binary data
      const chunks: Array<Uint8Array> = []
      const chunkSizes = [0, 1, 2, 7, 100, 1024]

      for (const size of chunkSizes) {
        if (size === 0) continue // Skip 0 - protocol now rejects empty appends

        const chunk = new Uint8Array(size)
        for (let i = 0; i < size; i++) {
          chunk[i] = Math.floor(Math.random() * 256)
        }
        chunks.push(chunk)

        await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `application/octet-stream` },
          body: chunk,
        })
      }

      // Calculate expected concatenated result
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const expected = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        expected.set(chunk, offset)
        offset += chunk.length
      }

      // Read entire stream by following Stream-Next-Offset
      const accumulated: Array<number> = []
      let currentOffset: string | null = null
      let iterations = 0
      const maxIterations = 100

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
          // Reached the end
          break
        }

        expect(nextOffset).toBeDefined()
        if (nextOffset === currentOffset) {
          // Offset should progress
          throw new Error(`Offset did not progress: stuck at ${currentOffset}`)
        }

        currentOffset = nextOffset
      }

      expect(iterations).toBeLessThan(maxIterations)

      // Verify byte-for-byte exactness
      const result = new Uint8Array(accumulated)
      expect(result.length).toBe(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(result[i]).toBe(expected[i])
      }
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

    test(`should accept cursor parameter for collapsing`, async () => {
      const streamPath = `/v1/stream/longpoll-cursor-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Long-poll with cursor param should not error
      const response = await fetch(
        `${getBaseUrl()}${streamPath}?offset=-1&live=long-poll&cursor=test-cursor-123`,
        {
          method: `GET`,
        }
      )

      expect(response.status).toBe(200)

      // If server returns Stream-Cursor, we can echo it back
      const cursor = response.headers.get(`Stream-Cursor`)
      if (cursor) {
        // Just verify it's a string
        expect(typeof cursor).toBe(`string`)
      }
    })

    test(`should return Stream-Up-To-Date and Stream-Next-Offset on 204 timeout`, async () => {
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
    }, 10000)
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
      expect([200, 204]).toContain(response2.status)
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
  // Property-Based Fuzzing
  // ============================================================================

  describe(`Property-Based Fuzzing`, () => {
    test(`random append/read sequences maintain invariants`, async () => {
      const streamPath = `/v1/stream/fuzz-append-read-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/octet-stream` },
      })

      // Track what we've written
      const expectedData: Array<number> = []

      // Random number of operations
      const numOperations = Math.floor(Math.random() * 20) + 10

      for (let i = 0; i < numOperations; i++) {
        // Random size between 1 and 1000 bytes
        const size = Math.floor(Math.random() * 1000) + 1
        const chunk = new Uint8Array(size)

        for (let j = 0; j < size; j++) {
          chunk[j] = Math.floor(Math.random() * 256)
        }

        // Append
        const response = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `application/octet-stream` },
          body: chunk,
        })

        expect([200, 204]).toContain(response.status)
        expectedData.push(...Array.from(chunk))
      }

      // Read back everything and verify
      const accumulated: Array<number> = []
      let currentOffset: string | null = null
      let iterations = 0

      while (iterations < 1000) {
        iterations++

        const url: string = currentOffset
          ? `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(currentOffset)}`
          : `${getBaseUrl()}${streamPath}`

        const response: Response = await fetch(url, { method: `GET` })
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

      // Verify exact match
      const result = new Uint8Array(accumulated)
      expect(result.length).toBe(expectedData.length)
      for (let i = 0; i < expectedData.length; i++) {
        expect(result[i]).toBe(expectedData[i])
      }
    })

    test(`random offset reads always return consistent data`, async () => {
      const streamPath = `/v1/stream/fuzz-offset-reads-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append some chunks and save offsets
      const chunks: Array<string> = []
      const offsets: Array<string> = []

      for (let i = 0; i < 10; i++) {
        const chunk = `chunk${i}-${Math.random()}`
        chunks.push(chunk)

        const response = await fetch(`${getBaseUrl()}${streamPath}`, {
          method: `POST`,
          headers: { "Content-Type": `text/plain` },
          body: chunk,
        })

        const offset = response.headers.get(STREAM_OFFSET_HEADER)
        expect(offset).toBeDefined()
        offsets.push(offset!)
      }

      // Now read from random offsets multiple times
      for (let i = 0; i < 5; i++) {
        const randomIdx = Math.floor(Math.random() * offsets.length)
        const offset = offsets[randomIdx]!

        // Read twice from same offset
        const response1 = await fetch(
          `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(offset)}`,
          { method: `GET` }
        )
        const text1 = await response1.text()

        const response2 = await fetch(
          `${getBaseUrl()}${streamPath}?offset=${encodeURIComponent(offset)}`,
          { method: `GET` }
        )
        const text2 = await response2.text()

        // Should be identical
        expect(text1).toBe(text2)
      }
    })
  })

  // ============================================================================
  // Malformed Input Fuzzing
  // ============================================================================

  describe(`Malformed Input Fuzzing`, () => {
    test(`should reject malformed offset characters`, async () => {
      const streamPath = `/v1/stream/fuzz-bad-offset-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      // Test various invalid offset characters
      const badOffsets = [
        `%20`,
        `/`,
        `..`,
        `<script>`,
        `\u0000`,
        `\n`,
        `\r\n`,
        `foo bar`,
        `foo%2Fbar`,
        `../../../etc/passwd`,
      ]

      for (const badOffset of badOffsets) {
        const response = await fetch(
          `${getBaseUrl()}${streamPath}?offset=${badOffset}`,
          {
            method: `GET`,
          }
        )

        // Should reject with 400 or similar error
        expect(response.status).toBeGreaterThanOrEqual(400)
      }
    })
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

    test(`should accept cursor parameter in SSE mode`, async () => {
      const streamPath = `/v1/stream/sse-cursor-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      const { response, received } = await fetchSSE(
        `${getBaseUrl()}${streamPath}?offset=-1&live=sse&cursor=test-cursor-456`,
        { untilContent: `streamCursor` }
      )

      expect(response.status).toBe(200)
      // Cursor should be echoed in control events
      expect(received).toContain(`test-cursor-456`)
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

      // Extract and parse the JSON payload to verify it's valid
      const dataLine = received
        .split(`\n`)
        .find((l) => l.startsWith(`data: `) && l.includes(`[`))
      expect(dataLine).toBeDefined()

      const payload = dataLine!.slice(`data: `.length)
      // This will throw if JSON is invalid (e.g., trailing comma)
      const parsed = JSON.parse(payload)

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
}

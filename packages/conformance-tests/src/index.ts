/**
 * Conformance test suite for Durable Streams server implementations
 *
 * This package provides a standardized test suite that can be run against
 * any server implementation to verify protocol compliance.
 */

import { describe, expect, test } from "vitest"
import { DurableStream } from "@durable-streams/writer"
import {
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "@durable-streams/client"

export interface ConformanceTestOptions {
  /** Base URL of the server to test */
  baseUrl: string
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
      await expect(async () => {
        for await (const _chunk of stream.read({ live: false })) {
          // Should throw before yielding
        }
      }).rejects.toThrow()
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

      let text = ``
      for await (const chunk of stream.read({ live: false })) {
        text += new TextDecoder().decode(chunk.data)
      }
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

      let text = ``
      for await (const chunk of stream.read({ live: false })) {
        text += new TextDecoder().decode(chunk.data)
      }
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

      let dataLength = 0
      let sawUpToDate = false
      for await (const chunk of stream.read({ live: false })) {
        dataLength += chunk.data.length
        if (chunk.upToDate) sawUpToDate = true
      }

      expect(dataLength).toBe(0)
      expect(sawUpToDate).toBe(true)
    })

    test(`should read stream with data`, async () => {
      const streamPath = `/v1/stream/read-data-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`hello`)

      let text = ``
      let sawUpToDate = false
      for await (const chunk of stream.read({ live: false })) {
        text += new TextDecoder().decode(chunk.data)
        if (chunk.upToDate) sawUpToDate = true
      }

      expect(text).toBe(`hello`)
      expect(sawUpToDate).toBe(true)
    })

    test(`should read from offset`, async () => {
      const streamPath = `/v1/stream/read-offset-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${getBaseUrl()}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`first`)
      let firstOffset = ``
      for await (const chunk of stream.read({ live: false })) {
        firstOffset = chunk.offset
      }

      await stream.append(`second`)

      let text = ``
      for await (const chunk of stream.read({
        offset: firstOffset,
        live: false,
      })) {
        text += new TextDecoder().decode(chunk.data)
      }

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
        for await (const chunk of stream.read({
          live: `long-poll`,
        })) {
          if (chunk.data.length > 0) {
            receivedData.push(new TextDecoder().decode(chunk.data))
          }
          if (receivedData.length >= 1) {
            break
          }
        }
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

      // Long-poll from beginning should return immediately
      let text = ``
      for await (const chunk of stream.read({ live: `long-poll` })) {
        text += new TextDecoder().decode(chunk.data)
        if (chunk.data.length > 0) break
      }

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

    test(`should return 400 or 409 on content-type mismatch`, async () => {
      const streamPath = `/v1/stream/content-type-mismatch-test-${Date.now()}`

      // Create with text/plain
      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try to append with application/json - protocol allows 400 or 409
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{}`,
      })

      expect([400, 409]).toContain(response.status)
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

      // Try to append with application/json - protocol allows 400 or 409
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{"test": true}`,
      })

      expect([400, 409]).toContain(response.status)
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

    test(`should enforce monotonic offset progression`, async () => {
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

      // Verify offsets are lexicographically increasing
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
      const response = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `POST`,
        body: `data`,
      })

      expect([400, 409]).toContain(response.status)
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
    test(`should support ETag and If-None-Match for 304`, async () => {
      const streamPath = `/v1/stream/etag-test-${Date.now()}`

      await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // First request
      const response1 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
      })

      const etag = response1.headers.get(`etag`)
      expect(etag).toBeDefined()

      // Second request with If-None-Match
      const response2 = await fetch(`${getBaseUrl()}${streamPath}`, {
        method: `GET`,
        headers: {
          "If-None-Match": etag!,
        },
      })

      // Server MAY return 304 or 200
      if (response2.status === 304) {
        // 304 should have empty body
        const text = await response2.text()
        expect(text).toBe(``)
      } else if (response2.status === 200) {
        // 200 should have same data
        const text = await response2.text()
        expect(text).toBe(`test data`)
      } else {
        throw new Error(`Unexpected status: ${response2.status}`)
      }
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
}

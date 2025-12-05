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
  const { baseUrl } = options

  // ============================================================================
  // Basic Stream Operations
  // ============================================================================

  describe(`Basic Stream Operations`, () => {
    test(`should create a stream`, async () => {
      const streamPath = `/v1/stream/create-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      expect(stream.url).toBe(`${baseUrl}${streamPath}`)
    })

    test(`should allow idempotent create with same config`, async () => {
      const streamPath = `/v1/stream/duplicate-test-${Date.now()}`

      // Create first stream
      await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      // Create again with same config - should succeed (idempotent)
      await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })
    })

    test(`should reject create with different config (409)`, async () => {
      const streamPath = `/v1/stream/config-mismatch-test-${Date.now()}`

      // Create with text/plain
      await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      // Try to create with different content type - should fail
      await expect(
        DurableStream.create({
          url: `${baseUrl}${streamPath}`,
          contentType: `application/json`,
        })
      ).rejects.toThrow()
    })

    test(`should delete a stream`, async () => {
      const streamPath = `/v1/stream/delete-test-${Date.now()}`

      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.delete()

      // Verify it's gone by trying to read
      await expect(stream.read()).rejects.toThrow()
    })
  })

  // ============================================================================
  // Append Operations
  // ============================================================================

  describe(`Append Operations`, () => {
    test(`should append string data`, async () => {
      const streamPath = `/v1/stream/append-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`hello world`)

      const result = await stream.read()
      const text = new TextDecoder().decode(result.data)
      expect(text).toBe(`hello world`)
    })

    test(`should append multiple chunks`, async () => {
      const streamPath = `/v1/stream/multi-append-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`chunk1`)
      await stream.append(`chunk2`)
      await stream.append(`chunk3`)

      const result = await stream.read()
      const text = new TextDecoder().decode(result.data)
      expect(text).toBe(`chunk1chunk2chunk3`)
    })

    test(`should enforce sequence ordering with seq`, async () => {
      const streamPath = `/v1/stream/seq-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
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
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      const result = await stream.read()

      expect(result.data).toHaveLength(0)
      expect(result.upToDate).toBe(true)
    })

    test(`should read stream with data`, async () => {
      const streamPath = `/v1/stream/read-data-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`hello`)

      const result = await stream.read()
      const text = new TextDecoder().decode(result.data)

      expect(text).toBe(`hello`)
      expect(result.upToDate).toBe(true)
    })

    test(`should read from offset`, async () => {
      const streamPath = `/v1/stream/read-offset-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      await stream.append(`first`)
      const firstResult = await stream.read()

      await stream.append(`second`)

      const result = await stream.read({ offset: firstResult.offset })
      const text = new TextDecoder().decode(result.data)

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
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      const receivedData: Array<string> = []

      // Start following in long-poll mode
      const followPromise = (async () => {
        for await (const chunk of stream.follow({
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

      await followPromise

      expect(receivedData).toContain(`new data`)
    }, 10000)

    test(`should return immediately if data already exists`, async () => {
      const streamPath = `/v1/stream/longpoll-immediate-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      // Add data first
      await stream.append(`existing data`)

      // Long-poll from beginning should return immediately
      const result = await stream.read({ live: `long-poll` })
      const text = new TextDecoder().decode(result.data)

      expect(text).toBe(`existing data`)
    })
  })

  // ============================================================================
  // HTTP Protocol Tests
  // ============================================================================

  describe(`HTTP Protocol`, () => {
    test(`should return correct headers on PUT`, async () => {
      const streamPath = `/v1/stream/put-headers-test-${Date.now()}`

      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      const firstResponse = await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })
      expect(firstResponse.status).toBe(201)

      // Second PUT with same config should succeed
      const secondResponse = await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })
      expect([200, 204]).toContain(secondResponse.status)
    })

    test(`should return 409 on PUT with different config`, async () => {
      const streamPath = `/v1/stream/config-conflict-test-${Date.now()}`

      // First PUT with text/plain
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Second PUT with different content type should fail
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })

      expect(response.status).toBe(409)
    })

    test(`should return correct headers on POST`, async () => {
      const streamPath = `/v1/stream/post-headers-test-${Date.now()}`

      // Create stream
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append data
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `hello world`,
      })

      expect([200, 204]).toContain(response.status)
      expect(response.headers.get(STREAM_OFFSET_HEADER)).toBeDefined()
    })

    test(`should return 404 on POST to non-existent stream`, async () => {
      const streamPath = `/v1/stream/post-404-test-${Date.now()}`

      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `data`,
      })

      expect(response.status).toBe(404)
    })

    test(`should return 400 on content-type mismatch`, async () => {
      const streamPath = `/v1/stream/content-type-mismatch-test-${Date.now()}`

      // Create with text/plain
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try to append with application/json
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{}`,
      })

      expect(response.status).toBe(400)
    })

    test(`should return correct headers on GET`, async () => {
      const streamPath = `/v1/stream/get-headers-test-${Date.now()}`

      // Create and add data
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // Read data
      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Read empty stream
      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `first`,
      })

      // Append more
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `second`,
      })

      // Get the first offset (after "first")
      const firstResponse = await fetch(`${baseUrl}${streamPath}`, {
        method: `GET`,
      })
      const firstText = await firstResponse.text()
      expect(firstText).toBe(`firstsecond`)

      // Now create fresh and read from middle offset
      const streamPath2 = `/v1/stream/get-offset-test2-${Date.now()}`
      await fetch(`${baseUrl}${streamPath2}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `first`,
      })
      const middleResponse = await fetch(`${baseUrl}${streamPath2}`, {
        method: `GET`,
      })
      const middleOffset = middleResponse.headers.get(STREAM_OFFSET_HEADER)

      // Append more
      await fetch(`${baseUrl}${streamPath2}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `second`,
      })

      // Read from the middle offset
      const response = await fetch(
        `${baseUrl}${streamPath2}?offset=${middleOffset}`,
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

      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `DELETE`,
      })

      expect(response.status).toBe(404)
    })

    test(`should return 204 on successful DELETE`, async () => {
      const streamPath = `/v1/stream/delete-success-test-${Date.now()}`

      // Create stream
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Delete it
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `DELETE`,
      })

      expect(response.status).toBe(204)

      // Verify it's gone
      const readResponse = await fetch(`${baseUrl}${streamPath}`, {
        method: `GET`,
      })
      expect(readResponse.status).toBe(404)
    })

    test(`should enforce sequence ordering`, async () => {
      const streamPath = `/v1/stream/seq-test-${Date.now()}`

      // Create stream
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq 001
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `001`,
        },
        body: `first`,
      })

      // Append with seq 002
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `002`,
        },
        body: `second`,
      })

      // Try to append with seq 001 (regression) - should fail
      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq "2"
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `2`,
        },
        body: `first`,
      })

      // Try to append with seq "10" - should fail (lexicographically "10" < "2")
      // A numeric implementation would incorrectly accept this (10 > 2)
      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq "09"
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `09`,
        },
        body: `first`,
      })

      // Append with seq "10" - should succeed (lexicographically "10" > "09")
      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with seq "001"
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          [STREAM_SEQ_HEADER]: `001`,
        },
        body: `first`,
      })

      // Try to append with same seq "001" - should fail
      const response = await fetch(`${baseUrl}${streamPath}`, {
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

      const response = await fetch(`${baseUrl}${streamPath}`, {
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

      const response = await fetch(`${baseUrl}${streamPath}`, {
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

      const response = await fetch(`${baseUrl}${streamPath}`, {
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

      const response = await fetch(`${baseUrl}${streamPath}`, {
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

      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with mixed case - should succeed
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `TEXT/PLAIN` },
        body: `test`,
      })

      expect([200, 204]).toContain(response.status)
    })

    test(`should allow idempotent create with different case content-type`, async () => {
      const streamPath = `/v1/stream/case-idempotent-test-${Date.now()}`

      // Create with lowercase
      const response1 = await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })
      expect(response1.status).toBe(201)

      // PUT again with uppercase - should be idempotent
      const response2 = await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `APPLICATION/JSON` },
      })
      expect([200, 204]).toContain(response2.status)
    })

    test(`should accept headers with different casing`, async () => {
      const streamPath = `/v1/stream/case-header-test-${Date.now()}`

      // Create stream
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append with different header casing (lowercase)
      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Try to append with application/json - should fail
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{"test": true}`,
      })

      expect(response.status).toBe(400)
    })

    test(`should allow append with matching content-type`, async () => {
      const streamPath = `/v1/stream/content-type-match-test-${Date.now()}`

      // Create with application/json
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
      })

      // Append with same content-type - should succeed
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `{"test": true}`,
      })

      expect([200, 204]).toContain(response.status)
    })

    test(`should return stream content-type on GET`, async () => {
      const streamPath = `/v1/stream/content-type-get-test-${Date.now()}`

      // Create with application/json
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `application/json` },
        body: `{"initial": true}`,
      })

      // Read and verify content-type
      const response = await fetch(`${baseUrl}${streamPath}`, {
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test data`,
      })

      // HEAD request
      const response = await fetch(`${baseUrl}${streamPath}`, {
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

      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `HEAD`,
      })

      expect(response.status).toBe(404)
    })

    test(`should return tail offset`, async () => {
      const streamPath = `/v1/stream/head-offset-test-${Date.now()}`

      // Create empty stream
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // HEAD should show initial offset
      const response1 = await fetch(`${baseUrl}${streamPath}`, {
        method: `HEAD`,
      })
      const offset1 = response1.headers.get(STREAM_OFFSET_HEADER)
      expect(offset1).toBeDefined()

      // Append data
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      // HEAD should show updated offset
      const response2 = await fetch(`${baseUrl}${streamPath}`, {
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

      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      const response = await fetch(`${baseUrl}${streamPath}?offset=0,1`, {
        method: `GET`,
      })

      expect(response.status).toBe(400)
    })

    test(`should reject offset with spaces`, async () => {
      const streamPath = `/v1/stream/offset-spaces-test-${Date.now()}`

      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      const response = await fetch(`${baseUrl}${streamPath}?offset=0 1`, {
        method: `GET`,
      })

      expect(response.status).toBe(400)
    })

    test(`should support resumable reads (no duplicate data)`, async () => {
      const streamPath = `/v1/stream/resumable-test-${Date.now()}`

      // Create stream
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append chunk 1
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `chunk1`,
      })

      // Read chunk 1
      const response1 = await fetch(`${baseUrl}${streamPath}`, {
        method: `GET`,
      })
      const text1 = await response1.text()
      const offset1 = response1.headers.get(STREAM_OFFSET_HEADER)

      expect(text1).toBe(`chunk1`)
      expect(offset1).toBeDefined()

      // Append chunk 2
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `chunk2`,
      })

      // Read from offset1 - should only get chunk2
      const response2 = await fetch(
        `${baseUrl}${streamPath}?offset=${offset1}`,
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
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `test`,
      })

      // Read all data
      const response1 = await fetch(`${baseUrl}${streamPath}`, {
        method: `GET`,
      })
      const tailOffset = response1.headers.get(STREAM_OFFSET_HEADER)

      // Read from tail offset - should return empty with up-to-date
      const response2 = await fetch(
        `${baseUrl}${streamPath}?offset=${tailOffset}`,
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
  // Read-Your-Writes Consistency
  // ============================================================================

  describe(`Read-Your-Writes Consistency`, () => {
    test(`should immediately read message after append`, async () => {
      const streamPath = `/v1/stream/ryw-test-${Date.now()}`

      // Create stream and append
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `initial`,
      })

      // Immediately read - should see the data
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `GET`,
      })

      const text = await response.text()
      expect(text).toBe(`initial`)
    })

    test(`should immediately read multiple appends`, async () => {
      const streamPath = `/v1/stream/ryw-multi-test-${Date.now()}`

      // Create stream
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Append multiple messages
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `msg1`,
      })

      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `msg2`,
      })

      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `msg3`,
      })

      // Immediately read - should see all messages
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `GET`,
      })

      const text = await response.text()
      expect(text).toBe(`msg1msg2msg3`)
    })

    test(`should serve offset-based reads immediately after append`, async () => {
      const streamPath = `/v1/stream/ryw-offset-test-${Date.now()}`

      // Create stream with first message
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
        body: `first`,
      })

      // Get offset
      const response1 = await fetch(`${baseUrl}${streamPath}`, {
        method: `GET`,
      })
      const offset1 = response1.headers.get(STREAM_OFFSET_HEADER)!

      // Append more messages immediately
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `second`,
      })

      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: { "Content-Type": `text/plain` },
        body: `third`,
      })

      // Immediately read from offset1 - should see second and third
      const response2 = await fetch(
        `${baseUrl}${streamPath}?offset=${offset1}`,
        {
          method: `GET`,
        }
      )

      const text = await response2.text()
      expect(text).toBe(`secondthird`)
    })
  })
}

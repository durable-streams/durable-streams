/**
 * Conformance test suite for Durable Streams server implementations
 *
 * This package provides a standardized test suite that can be run against
 * any server implementation to verify protocol compliance.
 */

import { describe, expect, test } from "vitest"
import { DurableStream } from "@durable-streams/client"

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

    test(`should fail to create duplicate stream`, async () => {
      const streamPath = `/v1/stream/duplicate-test-${Date.now()}`

      // Create first stream
      await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
      })

      // Try to create duplicate - should fail
      await expect(
        DurableStream.create({
          url: `${baseUrl}${streamPath}`,
          contentType: `text/plain`,
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
      const result = await stream.read({ live: `long-poll`, offset: `0_0` })
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
      expect(response.headers.get(`stream-offset`)).toBe(`0_0`)
    })

    test(`should return 409 on duplicate PUT`, async () => {
      const streamPath = `/v1/stream/duplicate-put-test-${Date.now()}`

      // First PUT
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      // Second PUT should fail
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
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

      expect(response.status).toBe(204)
      expect(response.headers.get(`stream-offset`)).toBe(`0_11`)
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
      expect(response.headers.get(`stream-offset`)).toBe(`0_9`)
      expect(response.headers.get(`stream-up-to-date`)).toBe(`true`)
      expect(response.headers.get(`etag`)).toMatch(/^"stream:0:9"$/)

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
      expect(response.headers.get(`stream-offset`)).toBe(`0_0`)
      expect(response.headers.get(`stream-up-to-date`)).toBe(`true`)

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

      // Read from offset 5 (after "first")
      const response = await fetch(`${baseUrl}${streamPath}?offset=0_5`, {
        method: `GET`,
      })

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
          "stream-seq": `001`,
        },
        body: `first`,
      })

      // Append with seq 002
      await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          "stream-seq": `002`,
        },
        body: `second`,
      })

      // Try to append with seq 001 (regression) - should fail
      const response = await fetch(`${baseUrl}${streamPath}`, {
        method: `POST`,
        headers: {
          "Content-Type": `text/plain`,
          "stream-seq": `001`,
        },
        body: `invalid`,
      })

      expect(response.status).toBe(409)
    })
  })
}

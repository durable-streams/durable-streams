/**
 * HTTP API Tests
 *
 * Tests for the batch transaction HTTP API.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createMapStore, createServer } from "../src/index"
import type { BatchRequest, BatchResponse } from "../src/index"

describe(`HTTP API`, () => {
  let server: ReturnType<typeof createServer>
  let baseUrl: string

  beforeAll(async () => {
    const store = createMapStore()
    server = createServer({
      store,
      port: 0, // Random port
      host: `127.0.0.1`,
      cors: `*`,
    })
    // Wait for server to be listening
    await new Promise<void>((resolve) => {
      server.server.once(`listening`, resolve)
    })
    // Get actual port
    const addr = server.server.address()
    const port = typeof addr === `object` && addr ? addr.port : 3000
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await server.close()
  })

  describe(`POST /txn/batch`, () => {
    it(`executes a simple assign and read`, async () => {
      const request: BatchRequest = {
        operations: [
          { op: `update`, key: `key1`, effect: { type: `assign`, value: 42 } },
          { op: `read`, key: `key1` },
        ],
      }

      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify(request),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as BatchResponse
      expect(body.success).toBe(true)
      expect(body.reads).toHaveLength(1)
      expect(body.reads[0]?.value).toBe(42)
      expect(body.commitTs).toBeDefined()
    })

    it(`reads return null for non-existent keys`, async () => {
      const request: BatchRequest = {
        operations: [{ op: `read`, key: `nonexistent-key-${Date.now()}` }],
      }

      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify(request),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as BatchResponse
      expect(body.success).toBe(true)
      expect(body.reads[0]?.value).toBe(null)
    })

    it(`supports increment effects`, async () => {
      const key = `counter-${Date.now()}`

      // First: assign initial value
      await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({
          operations: [
            { op: `update`, key, effect: { type: `assign`, value: 100 } },
          ],
        }),
      })

      // Second: increment and read
      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({
          operations: [
            { op: `update`, key, effect: { type: `increment`, delta: 50 } },
            { op: `read`, key },
          ],
        }),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as BatchResponse
      expect(body.success).toBe(true)
      expect(body.reads[0]?.value).toBe(150)
    })

    it(`supports delete effects`, async () => {
      const key = `to-delete-${Date.now()}`

      // First: assign
      await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({
          operations: [
            { op: `update`, key, effect: { type: `assign`, value: `hello` } },
          ],
        }),
      })

      // Second: delete and read
      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({
          operations: [
            { op: `update`, key, effect: { type: `delete` } },
            { op: `read`, key },
          ],
        }),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as BatchResponse
      expect(body.success).toBe(true)
      expect(body.reads[0]?.value).toBe(null)
    })

    it(`returns snapshotTs in response`, async () => {
      const key = `ts-key-${Date.now()}`
      const request: BatchRequest = {
        operations: [
          { op: `update`, key, effect: { type: `assign`, value: 1 } },
        ],
      }

      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify(request),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as BatchResponse
      expect(body.success).toBe(true)
      expect(body.snapshotTs).toBeDefined()
      expect(typeof body.snapshotTs).toBe(`number`)
    })

    it(`supports idempotency keys in body`, async () => {
      const idempotencyKey = `idem-${Date.now()}`
      const key = `idem-key-${Date.now()}`

      const request: BatchRequest = {
        idempotencyKey,
        operations: [
          { op: `update`, key, effect: { type: `assign`, value: 999 } },
          { op: `read`, key },
        ],
      }

      // First request
      const response1 = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify(request),
      })

      const body1 = (await response1.json()) as BatchResponse
      expect(body1.success).toBe(true)
      expect(body1.cached).toBeUndefined()

      // Second request with same idempotency key
      const response2 = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify(request),
      })

      const body2 = (await response2.json()) as BatchResponse
      expect(body2.success).toBe(true)
      expect(body2.cached).toBe(true)
      expect(body2.txnId).toBe(body1.txnId)
      expect(body2.commitTs).toBe(body1.commitTs)
    })

    it(`supports idempotency keys in header`, async () => {
      const idempotencyKey = `header-idem-${Date.now()}`
      const key = `header-idem-key-${Date.now()}`

      const request: BatchRequest = {
        operations: [
          { op: `update`, key, effect: { type: `assign`, value: 888 } },
        ],
      }

      // First request
      const response1 = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(request),
      })

      const body1 = (await response1.json()) as BatchResponse
      expect(body1.success).toBe(true)

      // Second request with same header
      const response2 = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(request),
      })

      const body2 = (await response2.json()) as BatchResponse
      expect(body2.cached).toBe(true)
    })

    it(`handles multiple reads and updates`, async () => {
      const prefix = `multi-${Date.now()}`

      const request: BatchRequest = {
        operations: [
          {
            op: `update`,
            key: `${prefix}-a`,
            effect: { type: `assign`, value: 1 },
          },
          {
            op: `update`,
            key: `${prefix}-b`,
            effect: { type: `assign`, value: 2 },
          },
          {
            op: `update`,
            key: `${prefix}-c`,
            effect: { type: `assign`, value: 3 },
          },
          { op: `read`, key: `${prefix}-a` },
          { op: `read`, key: `${prefix}-b` },
          { op: `read`, key: `${prefix}-c` },
        ],
      }

      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify(request),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as BatchResponse
      expect(body.success).toBe(true)
      expect(body.reads).toHaveLength(3)
      expect(body.reads[0]?.value).toBe(1)
      expect(body.reads[1]?.value).toBe(2)
      expect(body.reads[2]?.value).toBe(3)
    })

    it(`returns 400 for invalid JSON`, async () => {
      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: `not valid json`,
      })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: string; code: string }
      expect(body.code).toBe(`INVALID_JSON`)
    })

    it(`returns 400 for missing operations`, async () => {
      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: string; code: string }
      expect(body.code).toBe(`INVALID_REQUEST`)
    })
  })

  describe(`GET /health`, () => {
    it(`returns ok status`, async () => {
      const response = await fetch(`${baseUrl}/health`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { status: string }
      expect(body.status).toBe(`ok`)
    })
  })

  describe(`OPTIONS (CORS)`, () => {
    it(`returns CORS headers`, async () => {
      const response = await fetch(`${baseUrl}/txn/batch`, {
        method: `OPTIONS`,
      })

      expect(response.status).toBe(204)
      expect(response.headers.get(`Access-Control-Allow-Origin`)).toBe(`*`)
      expect(response.headers.get(`Access-Control-Allow-Methods`)).toContain(
        `POST`
      )
    })
  })

  describe(`404 handling`, () => {
    it(`returns 404 for unknown routes`, async () => {
      const response = await fetch(`${baseUrl}/unknown`)
      expect(response.status).toBe(404)
      const body = (await response.json()) as { error: string; code: string }
      expect(body.code).toBe(`NOT_FOUND`)
    })
  })
})

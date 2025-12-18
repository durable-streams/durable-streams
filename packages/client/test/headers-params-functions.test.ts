/**
 * Tests for function-based headers and params
 * Ported from Electric SQL client patterns
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { stream } from "../src/stream-api"
import { DurableStream } from "../src/stream"

describe(`function-based headers and params`, () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": `application/json`,
          "Stream-Next-Offset": `1`,
        },
      })
    )
  })

  describe(`headers`, () => {
    it(`should call sync function headers`, async () => {
      const headerFn = vi.fn().mockReturnValue(`Bearer token-123`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          Authorization: headerFn,
        },
      })

      expect(headerFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: `Bearer token-123`,
      })
    })

    it(`should call async function headers`, async () => {
      const headerFn = vi.fn().mockResolvedValue(`Bearer async-token`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          Authorization: headerFn,
        },
      })

      expect(headerFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: `Bearer async-token`,
      })
    })

    it(`should support multiple function headers`, async () => {
      const authFn = vi.fn().mockReturnValue(`Bearer token`)
      const tenantFn = vi.fn().mockResolvedValue(`tenant-123`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          Authorization: authFn,
          "X-Tenant-Id": tenantFn,
        },
      })

      expect(authFn).toHaveBeenCalledOnce()
      expect(tenantFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: `Bearer token`,
        "X-Tenant-Id": `tenant-123`,
      })
    })

    it(`should mix static and function headers`, async () => {
      const dynamicFn = vi.fn().mockReturnValue(`dynamic-value`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          "X-Static": `static-value`,
          "X-Dynamic": dynamicFn,
        },
      })

      expect(dynamicFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        "X-Static": `static-value`,
        "X-Dynamic": `dynamic-value`,
      })
    })
  })

  describe(`params`, () => {
    it(`should call sync function params`, async () => {
      const paramFn = vi.fn().mockReturnValue(`tenant-abc`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          tenant: paramFn,
        },
      })

      expect(paramFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`tenant`)).toBe(`tenant-abc`)
    })

    it(`should call async function params`, async () => {
      const paramFn = vi.fn().mockResolvedValue(`async-tenant`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          tenant: paramFn,
        },
      })

      expect(paramFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`tenant`)).toBe(`async-tenant`)
    })

    it(`should support multiple function params`, async () => {
      const tenantFn = vi.fn().mockReturnValue(`tenant-123`)
      const regionFn = vi.fn().mockResolvedValue(`us-west`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          tenant: tenantFn,
          region: regionFn,
        },
      })

      expect(tenantFn).toHaveBeenCalledOnce()
      expect(regionFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`tenant`)).toBe(`tenant-123`)
      expect(url.searchParams.get(`region`)).toBe(`us-west`)
    })

    it(`should mix static and function params`, async () => {
      const dynamicFn = vi.fn().mockReturnValue(`dynamic`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          static: `value`,
          dynamic: dynamicFn,
        },
      })

      expect(dynamicFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`static`)).toBe(`value`)
      expect(url.searchParams.get(`dynamic`)).toBe(`dynamic`)
    })
  })

  describe(`DurableStream handle merging`, () => {
    it(`should merge handle-level and call-level headers`, async () => {
      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          "X-Handle-Header": `from-handle`,
        },
      })

      await handle.stream({
        headers: {
          "X-Call-Header": `from-call`,
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers).toMatchObject({
        "X-Handle-Header": `from-handle`,
        "X-Call-Header": `from-call`,
      })
    })

    it(`should override handle headers with call headers`, async () => {
      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          Authorization: `Bearer handle-token`,
        },
      })

      await handle.stream({
        headers: {
          Authorization: `Bearer call-token`,
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers.Authorization).toBe(`Bearer call-token`)
    })

    it(`should merge handle-level and call-level params`, async () => {
      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          tenant: `handle-tenant`,
        },
      })

      await handle.stream({
        params: {
          region: `call-region`,
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`tenant`)).toBe(`handle-tenant`)
      expect(url.searchParams.get(`region`)).toBe(`call-region`)
    })

    it(`should override handle params with call params`, async () => {
      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          tenant: `handle-tenant`,
        },
      })

      await handle.stream({
        params: {
          tenant: `call-tenant`,
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`tenant`)).toBe(`call-tenant`)
    })

    it(`should resolve handle-level function headers`, async () => {
      const headerFn = vi.fn().mockReturnValue(`Bearer dynamic-token`)

      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          Authorization: headerFn,
        },
      })

      await handle.stream()

      expect(headerFn).toHaveBeenCalled()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: `Bearer dynamic-token`,
      })
    })

    it(`should resolve handle-level function params`, async () => {
      const paramFn = vi.fn().mockReturnValue(`dynamic-tenant`)

      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          tenant: paramFn,
        },
      })

      await handle.stream()

      expect(paramFn).toHaveBeenCalled()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`tenant`)).toBe(`dynamic-tenant`)
    })
  })

  describe(`combined headers and params`, () => {
    it(`should support both function headers and params`, async () => {
      const headerFn = vi.fn().mockReturnValue(`Bearer token`)
      const paramFn = vi.fn().mockReturnValue(`tenant-123`)

      await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          Authorization: headerFn,
        },
        params: {
          tenant: paramFn,
        },
      })

      expect(headerFn).toHaveBeenCalledOnce()
      expect(paramFn).toHaveBeenCalledOnce()

      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: `Bearer token`,
      })

      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get(`tenant`)).toBe(`tenant-123`)
    })
  })

  describe(`per-request resolution in live mode`, () => {
    it(`should call header functions on each long-poll request`, async () => {
      let callCount = 0
      const headerFn = vi.fn(() => {
        callCount++
        return `Bearer token-${callCount}`
      })

      let fetchCallCount = 0
      mockFetch.mockReset().mockImplementation(() => {
        fetchCallCount++
        if (fetchCallCount === 1) {
          return new Response(JSON.stringify([{ id: 1 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `1`,
            },
          })
        } else {
          return new Response(JSON.stringify([{ id: 2 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `2`,
              "Stream-Up-To-Date": `true`,
            },
          })
        }
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
        headers: {
          Authorization: headerFn,
        },
      })

      // Consume with subscriber to trigger live polling
      const items: Array<unknown> = []
      let batchCount = 0
      res.subscribeJson((batch) => {
        batchCount++
        items.push(...batch.items)
        if (batchCount >= 2) {
          res.cancel()
        }
      })

      // Wait for both batches
      await res.closed

      // Header function should be called multiple times (per-request resolution)
      // At least once for initial request and once for the poll
      expect(headerFn.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toMatch(
        /^Bearer token-/
      )
      expect(mockFetch.mock.calls[1][1].headers.Authorization).toMatch(
        /^Bearer token-/
      )
      // Verify different values were used (per-request resolution working)
      expect(mockFetch.mock.calls[0][1].headers.Authorization).not.toBe(
        mockFetch.mock.calls[1][1].headers.Authorization
      )
      expect(items).toHaveLength(2)
    })

    it(`should call param functions on each long-poll request`, async () => {
      let callCount = 0
      const paramFn = vi.fn(() => {
        callCount++
        return `tenant-${callCount}`
      })

      let fetchCallCount = 0
      mockFetch.mockReset().mockImplementation(() => {
        fetchCallCount++
        if (fetchCallCount === 1) {
          return new Response(JSON.stringify([{ id: 1 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `1`,
            },
          })
        } else {
          return new Response(JSON.stringify([{ id: 2 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `2`,
              "Stream-Up-To-Date": `true`,
            },
          })
        }
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
        params: {
          tenant: paramFn,
        },
      })

      // Consume with subscriber to trigger live polling
      const items: Array<unknown> = []
      let batchCount = 0
      res.subscribeJson((batch) => {
        batchCount++
        items.push(...batch.items)
        if (batchCount >= 2) {
          res.cancel()
        }
      })

      // Wait for both batches
      await res.closed

      // Param function should be called multiple times (per-request resolution)
      // At least once for initial request and once for the poll
      expect(paramFn.mock.calls.length).toBeGreaterThanOrEqual(2)

      const url1 = new URL(mockFetch.mock.calls[0][0])
      const url2 = new URL(mockFetch.mock.calls[1][0])

      expect(url1.searchParams.get(`tenant`)).toMatch(/^tenant-/)
      expect(url2.searchParams.get(`tenant`)).toMatch(/^tenant-/)
      // Verify different values were used (per-request resolution working)
      expect(url1.searchParams.get(`tenant`)).not.toBe(
        url2.searchParams.get(`tenant`)
      )

      expect(items).toHaveLength(2)
    })

    it(`should call both header and param functions on each poll`, async () => {
      let headerCallCount = 0
      let paramCallCount = 0

      const headerFn = vi.fn(() => {
        headerCallCount++
        return `Bearer token-${headerCallCount}`
      })

      const paramFn = vi.fn(() => {
        paramCallCount++
        return `tenant-${paramCallCount}`
      })

      let fetchCallCount = 0
      mockFetch.mockReset().mockImplementation(() => {
        fetchCallCount++
        if (fetchCallCount === 1) {
          return new Response(JSON.stringify([{ id: 1 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `1`,
            },
          })
        } else if (fetchCallCount === 2) {
          return new Response(JSON.stringify([{ id: 2 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `2`,
            },
          })
        } else {
          return new Response(JSON.stringify([{ id: 3 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `3`,
              "Stream-Up-To-Date": `true`,
            },
          })
        }
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
        headers: {
          Authorization: headerFn,
        },
        params: {
          tenant: paramFn,
        },
      })

      // Consume with subscriber to trigger live polling
      const items: Array<unknown> = []
      let batchCount = 0
      res.subscribeJson((batch) => {
        batchCount++
        items.push(...batch.items)
        if (batchCount >= 3) {
          res.cancel()
        }
      })

      // Wait for all batches
      await res.closed

      // Both functions should be called multiple times (per-request resolution)
      // At least 3 times (initial + 2 polls)
      expect(headerFn.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(paramFn.mock.calls.length).toBeGreaterThanOrEqual(3)

      // Verify each request had fresh/different values (per-request resolution working)
      const authValues = new Set()
      const tenantValues = new Set()
      for (let i = 0; i < 3; i++) {
        authValues.add(mockFetch.mock.calls[i][1].headers.Authorization)
        const url = new URL(mockFetch.mock.calls[i][0])
        tenantValues.add(url.searchParams.get(`tenant`))
      }
      // All 3 requests should have different auth tokens and tenant values
      expect(authValues.size).toBe(3)
      expect(tenantValues.size).toBe(3)

      expect(items).toHaveLength(3)
    })
  })
})

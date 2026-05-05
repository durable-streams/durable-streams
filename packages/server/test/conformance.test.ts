/**
 * Run conformance tests against server implementations
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  runConformanceTests,
  runConsumerConformanceTests,
  runPullWakeConformanceTests,
} from "@durable-streams/server-conformance-tests"
import { DurableStreamTestServer } from "../src/server"

// ============================================================================
// In-Memory Server Conformance Tests
// ============================================================================

describe(`In-Memory Server Implementation`, () => {
  let server: DurableStreamTestServer

  // Use object with mutable property so conformance tests can access it
  const config = { baseUrl: `` }

  beforeAll(async () => {
    server = new DurableStreamTestServer({
      port: 0,
      longPollTimeout: 500,
      webhooks: true,
    })
    await server.start()
    config.baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  // Pass the mutable config object
  runConformanceTests(config)
})

// ============================================================================
// File-Backed Server Conformance Tests
// ============================================================================

describe(`File-Backed Server Implementation`, () => {
  let server: DurableStreamTestServer
  let dataDir: string

  // Use object with mutable property so conformance tests can access it
  const config = { baseUrl: `` }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(tmpdir(), `conformance-test-`))
    server = new DurableStreamTestServer({
      dataDir,
      port: 0,
      longPollTimeout: 500,
      webhooks: true,
    })
    await server.start()
    config.baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  runConformanceTests(config)
})

// ============================================================================
// L1 Consumer Conformance Tests
// ============================================================================

describe(`L1 Consumer Protocol`, () => {
  let server: DurableStreamTestServer

  const config = { baseUrl: `` }

  beforeAll(async () => {
    server = new DurableStreamTestServer({
      port: 0,
      longPollTimeout: 500,
      webhooks: true,
    })
    await server.start()
    config.baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  runConsumerConformanceTests(() => ({
    get serverUrl() {
      return config.baseUrl
    },
  }))
})

// ============================================================================
// L2/B Pull-Wake Conformance Tests
// ============================================================================

describe(`L2/B Pull-Wake`, () => {
  let server: DurableStreamTestServer

  const config = { baseUrl: `` }

  beforeAll(async () => {
    server = new DurableStreamTestServer({
      port: 0,
      longPollTimeout: 500,
    })
    await server.start()
    config.baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  runPullWakeConformanceTests(() => ({
    get serverUrl() {
      return config.baseUrl
    },
  }))
})

// ============================================================================
// enrichPayload Failure Recovery Tests
// ============================================================================

describe(`enrichPayload failure recovery`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({
      port: 0,
      longPollTimeout: 500,
      webhooks: true,
    })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    server.setEnrichPayload(undefined)
    await server.stop()
  })

  it(`releases epoch and schedules delayed re-wake on enrichPayload failure`, async () => {
    // Set up a webhook receiver
    const { createServer } = await import(`node:http`)
    const receivedWakes: Array<Record<string, unknown>> = []
    let resolveWake: (() => void) | null = null

    const receiver = createServer((req, res) => {
      const chunks: Array<Buffer> = []
      req.on(`data`, (c: Buffer) => chunks.push(c))
      req.on(`end`, () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        receivedWakes.push(body)
        res.writeHead(200, { "content-type": `application/json` })
        res.end(JSON.stringify({ done: true }))
        if (resolveWake) resolveWake()
      })
    })
    await new Promise<void>((resolve) =>
      receiver.listen(0, `127.0.0.1`, () => resolve())
    )
    const addr = receiver.address() as { port: number }
    const webhookUrl = `http://127.0.0.1:${addr.port}`

    try {
      const ts = Date.now()
      const subPattern = `/agents/enrich-fail-${ts}/*`
      const streamPath = `/agents/enrich-fail-${ts}/s1`

      // Create subscription
      const subRes = await fetch(
        `${baseUrl}${subPattern}?subscription=enrich-fail-${ts}`,
        {
          method: `PUT`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ webhook: webhookUrl }),
        }
      )
      expect(subRes.status).toBe(201)

      // Install a failing enrichPayload — fail first 2 calls, succeed after
      let enrichCallCount = 0
      server.setEnrichPayload(async (payload) => {
        enrichCallCount++
        if (enrichCallCount <= 2) {
          throw new Error(`simulated enrichPayload failure #${enrichCallCount}`)
        }
        return payload
      })

      // Create stream (triggers consumer creation + wake attempt)
      await fetch(`${baseUrl}${streamPath}`, {
        method: `PUT`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify([{ event: `test` }]),
      })

      // Wait for a successful wake delivery (after backoff retries)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out waiting for successful wake after enrichPayload recovery`
              )
            ),
          15_000
        )
        const check = () => {
          if (receivedWakes.length > 0) {
            clearTimeout(timeout)
            resolve()
          } else {
            resolveWake = check
          }
        }
        check()
      })

      // enrichPayload was called at least 3 times (2 failures + 1 success)
      expect(enrichCallCount).toBeGreaterThanOrEqual(3)
      // A webhook was delivered
      expect(receivedWakes.length).toBeGreaterThanOrEqual(1)
      expect(receivedWakes[0]!.consumerId).toBeDefined()
    } finally {
      server.setEnrichPayload(undefined)
      receiver.closeAllConnections()
      await new Promise<void>((resolve) => receiver.close(() => resolve()))
    }
  }, 20_000)
})

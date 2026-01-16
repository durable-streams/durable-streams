/**
 * Run conformance tests against server implementations
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe } from "vitest"
import { runConformanceTests } from "@durable-streams/server-conformance-tests"
import { DurableStreamTestServer } from "../src/server"

// ============================================================================
// In-Memory Server Conformance Tests
// ============================================================================

describe(`In-Memory Server Implementation`, () => {
  let server: DurableStreamTestServer

  // Use object with mutable property so conformance tests can access it
  const config = { baseUrl: `` }

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0, longPollTimeout: 500 })
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

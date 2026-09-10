/**
 * Run conformance tests against Caddy Durable Streams implementation
 */

import { spawn } from "node:child_process"
import * as path from "node:path"
import { afterAll, beforeAll, describe } from "vitest"
import { runConformanceTests } from "@durable-streams/server-conformance-tests"
import type { ChildProcess } from "node:child_process"

// Shared Caddy server for all test suites
let caddy: ChildProcess | null = null
const port = 4437
const config = { baseUrl: `http://localhost:${port}` }

beforeAll(async () => {
  const caddyBinary = path.join(__dirname, `..`, `caddy`)
  const caddyfile = path.join(__dirname, `Caddyfile`)

  caddy = spawn(caddyBinary, [`run`, `--config`, caddyfile], {
    stdio: [`ignore`, `pipe`, `pipe`],
  })

  caddy.stderr?.on(`data`, (data: Buffer) => {
    process.stderr.write(`[caddy] ${data.toString()}`)
  })

  await waitForServer(config.baseUrl, 10000)
}, 15000)

afterAll(async () => {
  if (caddy) {
    caddy.kill(`SIGTERM`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

// ============================================================================
// Caddy Server Conformance Tests
// ============================================================================

describe(`Caddy Durable Streams Implementation`, () => {
  runConformanceTests(config)
})

async function waitForServer(
  baseUrl: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/v1/stream/__health__`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      if (response.ok || response.status === 201) {
        // Clean up health check stream
        await fetch(`${baseUrl}/v1/stream/__health__`, { method: `DELETE` })
        return
      }
    } catch {
      // Server not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}

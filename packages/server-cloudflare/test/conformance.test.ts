/**
 * Run conformance tests against the Cloudflare Workers + Durable Objects
 * implementation, booted locally via `wrangler dev` (workerd, local DO
 * SQLite, no credentials needed).
 */

import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe } from "vitest"
import { runConformanceTests } from "@durable-streams/server-conformance-tests"
import type { ChildProcess } from "node:child_process"

// Shared wrangler dev server for all test suites
let wrangler: ChildProcess | null = null
const port = 8790
const config = { baseUrl: `http://localhost:${port}` }

beforeAll(async () => {
  const packageDir = path.join(__dirname, `..`)
  const wranglerBin = path.join(packageDir, `node_modules`, `.bin`, `wrangler`)

  wrangler = spawn(
    wranglerBin,
    [
      `dev`,
      `--config`,
      path.join(__dirname, `wrangler.jsonc`),
      `--port`,
      String(port),
      `--inspector-port`,
      `0`,
      // Fresh DO storage per run: persisted local state from an earlier
      // schema must not leak into (or fail) the suite.
      `--persist-to`,
      mkdtempSync(path.join(os.tmpdir(), `ds-cf-conformance-`)),
    ],
    {
      cwd: packageDir,
      stdio: [`ignore`, `pipe`, `pipe`],
    }
  )

  wrangler.stderr?.on(`data`, (data: Buffer) => {
    process.stderr.write(`[wrangler] ${data.toString()}`)
  })

  await waitForServer(config.baseUrl, 30000)
}, 45000)

afterAll(async () => {
  if (wrangler) {
    wrangler.kill(`SIGTERM`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

describe(`Cloudflare Durable Objects Streams Implementation`, () => {
  runConformanceTests(config)
})

async function waitForServer(
  baseUrl: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/__health__`, {
        method: `PUT`,
        headers: { "Content-Type": `text/plain` },
      })

      if (response.ok || response.status === 201) {
        await fetch(`${baseUrl}/__health__`, { method: `DELETE` })
        return
      }
    } catch {
      // Server not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}

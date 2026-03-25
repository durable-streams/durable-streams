/**
 * Development server for the Yjs demo.
 *
 * Starts Caddy as an HTTPS reverse proxy (HTTP/2) with the Durable Streams
 * plugin, and a Node.js Yjs server behind it. Everything is served through
 * a single origin (https://localhost:4443) for HTTP/2 multiplexing.
 *
 * Usage:
 *   pnpm dev:server
 */

import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

// Trust Caddy's self-signed cert for localhost
process.env.NODE_TLS_REJECT_UNAUTHORIZED = `0`

const CADDY_PORT = 4443
const YJS_PORT = 4438

async function main() {
  // Start Yjs server first (internal, not exposed directly)
  const yjsServer = new YjsServer({
    port: YJS_PORT,
    host: `127.0.0.1`,
    dsServerUrl: `https://localhost:${CADDY_PORT}`,
    compactionThreshold: 1024 * 1024, // 1MB
  })

  await yjsServer.start()
  console.log(`✓ Yjs server running at http://127.0.0.1:${YJS_PORT} (internal)`)

  // Start Caddy with HTTPS (HTTP/2) reverse proxy
  const caddyBin = resolve(
    import.meta.dirname,
    `../../packages/caddy-plugin/durable-streams-server`
  )
  const caddyfile = resolve(import.meta.dirname, `Caddyfile`)

  const caddy = spawn(caddyBin, [`run`, `--config`, caddyfile], {
    stdio: [`ignore`, `pipe`, `pipe`],
  })

  // Wait for Caddy to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Caddy failed to start within 10s`)),
      10000
    )

    caddy.stderr.on(`data`, (data: Buffer) => {
      const line = data.toString()
      if (line.includes(`serving initial configuration`)) {
        clearTimeout(timeout)
        resolve()
      }
    })

    caddy.on(`error`, (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    caddy.on(`exit`, (code) => {
      clearTimeout(timeout)
      if (code !== null && code !== 0) {
        reject(new Error(`Caddy exited with code ${code}`))
      }
    })
  })

  const publicUrl = `https://localhost:${CADDY_PORT}`
  console.log(`✓ Caddy HTTPS proxy running at ${publicUrl}`)

  console.log(`\nYjs demo server is ready!`)
  console.log(`\nAll requests go through: ${publicUrl} (HTTP/2)`)
  console.log(`  DS streams:  ${publicUrl}/v1/stream/*`)
  console.log(`  Yjs docs:    ${publicUrl}/v1/yjs/*`)
  console.log(`\nRun the demo with: pnpm dev`)
  console.log(`\nPress Ctrl+C to stop the servers`)

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log(`\nShutting down servers...`)
    await yjsServer.stop()
    caddy.kill(`SIGTERM`)
    process.exit(0)
  }

  process.on(`SIGINT`, shutdown)
  process.on(`SIGTERM`, shutdown)
}

main().catch((err) => {
  console.error(`Failed to start servers:`, err)
  process.exit(1)
})

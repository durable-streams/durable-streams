/**
 * Development server for the Yjs demo.
 *
 * Starts the TypeScript Durable Streams reference server and a Node.js Yjs
 * server in front of it. The two listen on separate ports; point the demo at
 * them with VITE_DS_URL and VITE_YJS_URL.
 *
 * Usage:
 *   pnpm dev:server
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

const DS_PORT = 4437
const YJS_PORT = 4438

async function main() {
  const dsServer = new DurableStreamTestServer({
    port: DS_PORT,
    host: `127.0.0.1`,
    webhooks: true,
  })
  await dsServer.start()
  console.log(`✓ Durable Streams server running at ${dsServer.url}`)

  const yjsServer = new YjsServer({
    port: YJS_PORT,
    host: `127.0.0.1`,
    dsServerUrl: dsServer.url,
    compactionThreshold: 1024 * 1024, // 1MB
  })
  await yjsServer.start()
  console.log(`✓ Yjs server running at ${yjsServer.url}`)

  console.log(`\nYjs demo server is ready!`)
  console.log(`\nRun the demo with:`)
  console.log(
    `  VITE_DS_URL=${dsServer.url}/v1/stream VITE_YJS_URL=${yjsServer.url}/v1/yjs pnpm dev`
  )
  console.log(`\nPress Ctrl+C to stop the servers`)

  const shutdown = async () => {
    console.log(`\nShutting down servers...`)
    await yjsServer.stop()
    await dsServer.stop()
    process.exit(0)
  }

  process.on(`SIGINT`, shutdown)
  process.on(`SIGTERM`, shutdown)
}

main().catch((err) => {
  console.error(`Failed to start servers:`, err)
  process.exit(1)
})

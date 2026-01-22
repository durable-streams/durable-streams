/**
 * Development server for the Yjs demo.
 *
 * Starts both the Durable Streams server (storage backend) and the Yjs server
 * (protocol layer) on different ports.
 *
 * Usage:
 *   pnpm dev:server
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

const DS_PORT = 4437
const YJS_PORT = 4438

async function main() {
  // Start Durable Streams server (storage backend)
  const dsServer = new DurableStreamTestServer({
    port: DS_PORT,
    host: `0.0.0.0`,
  })

  const dsUrl = await dsServer.start()
  console.log(`✓ Durable Streams server running at ${dsUrl}`)

  // Start Yjs server (wraps DS server)
  const yjsServer = new YjsServer({
    port: YJS_PORT,
    host: `0.0.0.0`,
    dsServerUrl: dsUrl,
    compactionThreshold: 1024 * 1024, // 1MB
    minUpdatesBeforeCompaction: 100,
  })

  const yjsUrl = await yjsServer.start()
  console.log(`✓ Yjs server running at ${yjsUrl}`)

  console.log(`\n📝 Yjs demo server is ready!`)
  console.log(`\nThe demo app connects to: ${yjsUrl}/v1/yjs/rooms`)
  console.log(`\nRun the demo with: pnpm dev`)
  console.log(`\nPress Ctrl+C to stop the servers`)

  // Handle graceful shutdown
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

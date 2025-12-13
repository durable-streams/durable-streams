/**
 * Entrypoint for running the Durable Streams server standalone.
 * Used for Docker deployments and local development.
 */

import { DurableStreamTestServer } from "./src/index.js"

const PORT = parseInt(process.env.PORT ?? `3001`, 10)
const HOST = process.env.HOST ?? `0.0.0.0`
const DATA_DIR = process.env.DATA_DIR

const server = new DurableStreamTestServer({
  port: PORT,
  host: HOST,
  dataDir: DATA_DIR, // If set, uses file-backed storage; otherwise in-memory
})

const url = await server.start()
console.log(`Durable Streams server running at ${url}`)
console.log(`  Host: ${HOST}`)
console.log(`  Port: ${PORT}`)
console.log(
  `  Storage: ${DATA_DIR ? `file-backed (${DATA_DIR})` : `in-memory`}`
)

// Handle graceful shutdown
process.on(`SIGINT`, async () => {
  console.log(`\nShutting down...`)
  await server.stop()
  process.exit(0)
})

process.on(`SIGTERM`, async () => {
  console.log(`\nShutting down...`)
  await server.stop()
  process.exit(0)
})

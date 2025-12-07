/**
 * Simple example server for testing the Durable Streams CLI locally.
 *
 * Usage:
 *   pnpm start:dev
 */

import {
  DurableStreamTestServer,
  createRegistryHooks,
} from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 8787,
  host: `0.0.0.0`,
})

// Add hooks to maintain a __registry__ stream for observability
const hooks = createRegistryHooks(server.store)
;(server as any).options.onStreamCreated = hooks.onStreamCreated
;(server as any).options.onStreamDeleted = hooks.onStreamDeleted

const url = await server.start()
console.log(`✓ Durable Streams server running at ${url}`)
console.log(`\nYou can now use the CLI to interact with streams:`)
console.log(`  export STREAM_URL=${url}`)
console.log(`  durable-stream-dev create my-stream`)
console.log(`  durable-stream-dev write my-stream "Hello, world!"`)
console.log(`  durable-stream-dev read my-stream`)
console.log(`\nPress Ctrl+C to stop the server`)

// Handle graceful shutdown
process.on(`SIGINT`, async () => {
  console.log(`\nShutting down server...`)
  await server.stop()
  process.exit(0)
})

process.on(`SIGTERM`, async () => {
  console.log(`\nShutting down server...`)
  await server.stop()
  process.exit(0)
})

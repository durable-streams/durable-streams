#!/usr/bin/env node
/**
 * Start the durable-streams test server for Python integration tests.
 *
 * This script starts the server and prints the URL to stdout so the
 * Python test can read it.
 */

// Import from relative path to server package
import { DurableStreamTestServer } from "../../server/dist/index.js"

const port = parseInt(process.argv[2] || "0", 10)

const server = new DurableStreamTestServer({
  port,
  host: "127.0.0.1",
})

async function main() {
  const url = await server.start()
  // Print the URL so Python can read it
  console.log(`SERVER_URL=${url}`)

  // Keep the server running
  process.on("SIGTERM", async () => {
    await server.stop()
    process.exit(0)
  })

  process.on("SIGINT", async () => {
    await server.stop()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})

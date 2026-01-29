import "dotenv/config"
import { DurableStreamTestServer } from "@durable-streams/server"
import { createProxyServer } from "@durable-streams/proxy"

const DS_PORT = 4437
const PROXY_PORT = 4440
const JWT_SECRET = process.env.PROXY_SECRET || `dev-secret`
const CHAT_SERVER_PORT = process.env.SERVER_PORT
  ? parseInt(process.env.SERVER_PORT)
  : 3002

// Start the durable streams storage server
const dsServer = new DurableStreamTestServer({
  port: DS_PORT,
  host: `0.0.0.0`,
})

const dsUrl = await dsServer.start()
console.log(`✓ Durable Streams server running at ${dsUrl}`)

// Start the proxy server
const proxy = await createProxyServer({
  port: PROXY_PORT,
  host: `0.0.0.0`,
  durableStreamsUrl: dsUrl,
  jwtSecret: JWT_SECRET,
  allowlist: [
    `localhost:${CHAT_SERVER_PORT}/*`,
    `127.0.0.1:${CHAT_SERVER_PORT}/*`,
    `0.0.0.0:${CHAT_SERVER_PORT}/*`,
  ],
})

console.log(`✓ Durable Proxy server running at ${proxy.url}`)
console.log(
  `  Proxying to upstream servers matching: localhost:${CHAT_SERVER_PORT}/*`
)
console.log(`  Secret: ${JWT_SECRET}`)

// Handle graceful shutdown
const shutdown = async () => {
  console.log(`\nShutting down...`)
  await proxy.stop()
  await dsServer.stop()
  process.exit(0)
}

process.on(`SIGINT`, shutdown)
process.on(`SIGTERM`, shutdown)

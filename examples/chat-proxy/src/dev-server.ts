/**
 * Development server that runs:
 * 1. Stream Storage Server - stores stream data for durability
 * 2. Durable Proxy Server - handles durable fetch requests
 * 3. Express Backend - calls Anthropic API and streams responses
 *
 * Architecture: Client → Durable Proxy → Express Backend → Anthropic
 */
import { DurableStreamTestServer } from "@durable-streams/server"
import { createProxyServer } from "@durable-streams/proxy"
import { chat, toServerSentEventsResponse } from "@tanstack/ai"
import { anthropicText } from "@tanstack/ai-anthropic"
import express from "express"
import cors from "cors"
import dotenv from "dotenv"

dotenv.config()

const DURABLE_STREAMS_PORT = parseInt(
  process.env.DURABLE_STREAMS_PORT || `4001`
)
const PROXY_PORT = parseInt(process.env.PROXY_PORT || `4000`)
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || `4002`)
// Full model ID required - TanStack AI adapter passes it directly to Anthropic API
const MODEL = `claude-sonnet-4-20250514` as `claude-sonnet-4`

async function main() {
  console.log(`Starting development servers...\n`)

  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`Error: ANTHROPIC_API_KEY is not set in your .env file.`)
    process.exit(1)
  }

  // 1. Start Stream Storage Server (used by Durable Proxy for persistence)
  console.log(
    `[1/3] Starting Stream Storage Server on port ${DURABLE_STREAMS_PORT}...`
  )
  const durableStreams = new DurableStreamTestServer({
    port: DURABLE_STREAMS_PORT,
    host: `localhost`,
  })
  const durableStreamsUrl = await durableStreams.start()
  console.log(`      Stream Storage Server: ${durableStreamsUrl}`)

  // 2. Start Proxy Server
  console.log(`[2/3] Starting Proxy Server on port ${PROXY_PORT}...`)
  const proxy = await createProxyServer({
    port: PROXY_PORT,
    host: `localhost`,
    durableStreamsUrl,
    allowlist: [`http://localhost:${BACKEND_PORT}/**`],
    jwtSecret: `dev-secret-change-in-production`,
    streamTtlSeconds: 3600 * 24, // 24 hours
  })
  console.log(`      Proxy Server: ${proxy.url}`)

  // 3. Start Express Backend
  console.log(`[3/3] Starting Express Backend on port ${BACKEND_PORT}...`)
  const app = express()
  app.use(cors())
  app.use(express.json())

  // Chat endpoint - uses TanStack AI chat() and toServerSentEventsResponse()
  app.post(`/api/chat`, async (req, res) => {
    try {
      const { messages } = req.body

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ error: `messages array is required` })
        return
      }

      // Use TanStack AI's chat() function with the Anthropic adapter

      const stream = chat({
        adapter: anthropicText(MODEL),
        messages: messages as any,
        maxTokens: 8096,
      })

      // Convert to SSE response using TanStack AI's helper
      const sseResponse = toServerSentEventsResponse(stream)

      // Copy headers from SSE response
      sseResponse.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

      // Pipe the response body to Express
      if (sseResponse.body) {
        const reader = sseResponse.body.getReader()
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read()
          if (done) {
            res.end()
            return
          }
          res.write(value)
          return pump()
        }
        await pump()
      } else {
        res.end()
      }
    } catch (error) {
      console.error(`[Backend] Error:`, error)
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : `Unknown error`,
        })
      }
    }
  })

  const backendServer = app.listen(BACKEND_PORT, `localhost`)
  await new Promise<void>((resolve) => backendServer.on(`listening`, resolve))
  console.log(`      Express Backend: http://localhost:${BACKEND_PORT}`)

  console.log(`\n========================================`)
  console.log(`  All servers started!`)
  console.log(`========================================\n`)
  console.log(`Services:`)
  console.log(`  Stream Storage:  http://localhost:${DURABLE_STREAMS_PORT}`)
  console.log(`  Proxy Server:    http://localhost:${PROXY_PORT}`)
  console.log(`  Express Backend: http://localhost:${BACKEND_PORT}`)
  console.log(`\nArchitecture: Client → Proxy → Backend → Anthropic`)
  console.log(`\nRun "pnpm dev" in another terminal to start the frontend.`)
  console.log(`\nPress Ctrl+C to stop all services\n`)

  // Handle shutdown
  const shutdown = async () => {
    console.log(`\nShutting down...`)
    backendServer.close()
    await proxy.stop()
    await durableStreams.stop()
    process.exit(0)
  }

  process.on(`SIGINT`, shutdown)
  process.on(`SIGTERM`, shutdown)
}

main().catch((err) => {
  console.error(`Failed to start servers:`, err)
  process.exit(1)
})

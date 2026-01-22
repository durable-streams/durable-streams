/**
 * Development server that runs:
 * 1. Stream Storage Server - stores stream data for durability
 * 2. Durable Proxy Server - handles durable fetch requests
 * 3. Chat Backend Server - calls Anthropic API with proper auth
 */
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { DurableStreamTestServer } from "@durable-streams/server"
import { createProxyServer } from "@durable-streams/proxy"
import dotenv from "dotenv"
import { chat, toHttpResponse } from "@tanstack/ai"
import { anthropicText } from "@tanstack/ai-anthropic"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

dotenv.config()

const DURABLE_STREAMS_PORT = parseInt(
  process.env.DURABLE_STREAMS_PORT || `4001`
)
const PROXY_PORT = parseInt(process.env.PROXY_PORT || `4000`)
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || `3001`)

/**
 * Create a simple HTTP server that handles chat requests by calling Anthropic API.
 */
function createBackendServer(
  port: number
): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      // CORS headers
      res.setHeader(`Access-Control-Allow-Origin`, `*`)
      res.setHeader(`Access-Control-Allow-Methods`, `GET, POST, OPTIONS`)
      res.setHeader(`Access-Control-Allow-Headers`, `Content-Type`)

      if (req.method === `OPTIONS`) {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === `POST` && req.url === `/api/chat`) {
        // Collect request body
        const chunks: Array<Buffer> = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())

        try {
          // Filter out empty intermediate assistant messages (Anthropic rejects them)
          type Msg = { role: string; content: unknown }
          const messages = (body.messages || []).filter(
            (msg: Msg, idx: number, arr: Array<Msg>) =>
              msg.role !== `assistant` || msg.content || idx === arr.length - 1
          )

          // Use TanStack AI with Anthropic adapter
          const stream = chat({
            adapter: anthropicText(body.model || `claude-sonnet-4-20250514`),
            messages,
            maxTokens: body.max_tokens || 8096,
          })

          // Output raw JSON (no "data:" prefix) - the durable proxy will wrap
          // each line with "data:" to create proper SSE format for the client
          const response = toHttpResponse(stream)

          // Copy headers from Web Response to Node response
          const headers: Record<string, string> = {}
          response.headers.forEach((value, key) => {
            headers[key] = value
          })
          res.writeHead(response.status, headers)

          // Pipe the Web ReadableStream to Node response
          if (response.body) {
            const nodeStream = Readable.fromWeb(
              response.body as WebReadableStream
            )
            nodeStream.pipe(res)
          }
        } catch (error) {
          const err = error as Error
          res.writeHead(500, { "Content-Type": `application/json` })
          res.end(JSON.stringify({ error: err.message }))
        }
        return
      }

      res.writeHead(404)
      res.end(`Not found`)
    })

    server.listen(port, () => resolve(server))
  })
}

async function main() {
  console.log(`Starting development servers...\n`)

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
    allowlist: [
      `http://localhost:*/**`,
      `https://api.anthropic.com/**`,
      `https://api.openai.com/**`,
    ],
    jwtSecret: `dev-secret-change-in-production`,
    streamTtlSeconds: 3600 * 24, // 24 hours
  })
  console.log(`      Proxy Server: ${proxy.url}`)

  // 3. Start Backend Server
  console.log(`[3/3] Starting Backend Server on port ${BACKEND_PORT}...`)
  const backend = await createBackendServer(BACKEND_PORT)
  console.log(`      Backend Server: http://localhost:${BACKEND_PORT}`)

  console.log(`\n========================================`)
  console.log(`  All servers started!`)
  console.log(`========================================\n`)
  console.log(`Services:`)
  console.log(`  Stream Storage:  http://localhost:${DURABLE_STREAMS_PORT}`)
  console.log(`  Proxy Server:    http://localhost:${PROXY_PORT}`)
  console.log(`  Backend Server:  http://localhost:${BACKEND_PORT}`)
  console.log(`\nRun "npm run dev" in another terminal to start the frontend.`)
  console.log(`\nPress Ctrl+C to stop all services\n`)

  // Handle shutdown
  const shutdown = async () => {
    console.log(`\nShutting down...`)
    backend.close()
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

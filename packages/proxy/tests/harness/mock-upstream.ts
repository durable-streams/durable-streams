/**
 * Mock upstream server for testing.
 *
 * Simulates AI provider endpoints (like OpenAI, Anthropic) for testing
 * the proxy without making real API calls.
 */

import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

/**
 * Options for the mock upstream server.
 */
export interface MockUpstreamOptions {
  /** Port to listen on (default: 4439) */
  port?: number
  /** Host to bind to (default: 'localhost') */
  host?: string
}

/**
 * A mock response configuration.
 */
export interface MockResponse {
  /** HTTP status code (default: 200) */
  status?: number
  /** Response headers */
  headers?: Record<string, string>
  /** Response body - string, Buffer, or array of chunks for streaming */
  body?: string | Buffer | Array<string | Buffer>
  /** Delay between chunks in milliseconds (for streaming) */
  chunkDelayMs?: number
  /** Delay before sending response in milliseconds */
  delayMs?: number
  /** Whether to abort mid-stream (for testing error handling) */
  abortAfterChunks?: number
}

/**
 * A running mock upstream server.
 */
export interface MockUpstreamServer {
  /** The URL of the server */
  url: string
  /** Stop the server */
  stop: () => Promise<void>
  /** Set the next response to return */
  setResponse: (response: MockResponse) => void
  /** Set a handler for requests */
  setHandler: (
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  ) => void
  /** Get the last request received */
  getLastRequest: () => {
    method: string
    url: string
    headers: Record<string, string>
    body: string
  } | null
  /** Reset to default behavior */
  reset: () => void
}

/**
 * Create a mock upstream server for testing.
 *
 * @param options - Server options
 * @returns A running mock server
 *
 * @example
 * ```typescript
 * const upstream = await createMockUpstream({ port: 4439 })
 *
 * // Set a streaming response
 * upstream.setResponse({
 *   body: ['data: {"text": "Hello"}\n\n', 'data: {"text": " World"}\n\n'],
 *   chunkDelayMs: 100,
 * })
 *
 * // Make requests through the proxy...
 *
 * await upstream.stop()
 * ```
 */
export async function createMockUpstream(
  options: MockUpstreamOptions = {}
): Promise<MockUpstreamServer> {
  const port = options.port ?? 4439
  const host = options.host ?? `localhost`

  let nextResponse: MockResponse = { status: 200, body: `` }
  let customHandler:
    | ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>)
    | null = null
  let lastRequest: {
    method: string
    url: string
    headers: Record<string, string>
    body: string
  } | null = null

  const server: Server = createServer(async (req, res) => {
    // Collect request body
    const chunks: Array<Buffer> = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString(`utf-8`)

    // Record the request
    lastRequest = {
      method: req.method ?? `GET`,
      url: req.url ?? `/`,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(`, `) : (v ?? ``),
        ])
      ),
      body,
    }

    // Use custom handler if set
    if (customHandler) {
      await customHandler(req, res)
      return
    }

    // Apply delay if configured
    if (nextResponse.delayMs) {
      await sleep(nextResponse.delayMs)
    }

    // Set headers
    const headers: Record<string, string> = {
      "Content-Type": `text/event-stream`,
      ...nextResponse.headers,
    }

    res.writeHead(nextResponse.status ?? 200, headers)

    // Send body
    const responseBody = nextResponse.body
    if (!responseBody) {
      res.end()
      return
    }

    if (Array.isArray(responseBody)) {
      // Streaming response - send chunks with delays
      let chunkIndex = 0
      for (const chunk of responseBody) {
        if (
          nextResponse.abortAfterChunks !== undefined &&
          chunkIndex >= nextResponse.abortAfterChunks
        ) {
          // Simulate connection abort
          res.destroy()
          return
        }

        res.write(chunk)

        if (nextResponse.chunkDelayMs) {
          await sleep(nextResponse.chunkDelayMs)
        }

        chunkIndex++
      }
      res.end()
    } else {
      // Single response body
      res.end(responseBody)
    }
  })

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.on(`error`, reject)
    server.listen(port, host, () => {
      server.removeListener(`error`, reject)
      resolve()
    })
  })

  const url = `http://${host}:${port}`

  return {
    url,

    stop: async () => {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    },

    setResponse(response: MockResponse): void {
      nextResponse = response
      customHandler = null
    },

    setHandler(
      handler: (
        req: IncomingMessage,
        res: ServerResponse
      ) => void | Promise<void>
    ): void {
      customHandler = handler
    },

    getLastRequest() {
      return lastRequest
    },

    reset(): void {
      nextResponse = { status: 200, body: `` }
      customHandler = null
      lastRequest = null
    },
  }
}

/**
 * Helper to create SSE-formatted chunks.
 */
export function createSSEChunks(
  messages: Array<{ event?: string; data: string }>
): Array<string> {
  return messages.map(({ event, data }) => {
    let chunk = ``
    if (event) {
      chunk += `event: ${event}\n`
    }
    chunk += `data: ${data}\n\n`
    return chunk
  })
}

/**
 * Helper to create a typical AI streaming response.
 */
export function createAIStreamingResponse(
  tokens: Array<string>,
  delayMs = 50
): MockResponse {
  const chunks = tokens.map((token) => ({
    data: JSON.stringify({ choices: [{ delta: { content: token } }] }),
  }))

  // Add a done marker
  chunks.push({ data: `[DONE]` })

  return {
    headers: {
      "Content-Type": `text/event-stream`,
      "Cache-Control": `no-cache`,
    },
    body: createSSEChunks(chunks),
    chunkDelayMs: delayMs,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

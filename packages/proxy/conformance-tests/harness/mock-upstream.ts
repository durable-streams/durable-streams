import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

export interface MockUpstreamOptions {
  port?: number
  host?: string
}

export interface MockResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer | Array<string | Buffer>
  chunkDelayMs?: number
  delayMs?: number
  abortAfterChunks?: number
}

export interface MockUpstreamServer {
  url: string
  stop: () => Promise<void>
  setResponse: (response: MockResponse) => void
  setHandler: (
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  ) => void
  getLastRequest: () => {
    method: string
    url: string
    headers: Record<string, string>
    body: string
  } | null
  reset: () => void
}

export async function createMockUpstream(
  options: MockUpstreamOptions = {}
): Promise<MockUpstreamServer> {
  const port = options.port ?? 0
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
    const chunks: Array<Buffer> = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString(`utf-8`)

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

    if (customHandler) {
      await customHandler(req, res)
      return
    }

    if (nextResponse.delayMs) {
      await sleep(nextResponse.delayMs)
    }

    const headers: Record<string, string> = {
      "Content-Type": `text/event-stream`,
      ...nextResponse.headers,
    }
    res.writeHead(nextResponse.status ?? 200, headers)

    if (!nextResponse.body) {
      res.end()
      return
    }

    if (Array.isArray(nextResponse.body)) {
      let chunkIndex = 0
      for (const chunk of nextResponse.body) {
        if (
          nextResponse.abortAfterChunks !== undefined &&
          chunkIndex >= nextResponse.abortAfterChunks
        ) {
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
      return
    }

    res.end(nextResponse.body)
  })

  await new Promise<void>((resolve, reject) => {
    server.on(`error`, reject)
    server.listen(port, host, () => {
      server.removeListener(`error`, reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === `string`) {
    throw new Error(`Failed to read mock upstream listen address`)
  }
  const url = `http://${host}:${address.port}`

  return {
    url,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
    setResponse(response: MockResponse) {
      nextResponse = response
      customHandler = null
    },
    setHandler(handler) {
      customHandler = handler
    },
    getLastRequest() {
      return lastRequest
    },
    reset() {
      nextResponse = { status: 200, body: `` }
      customHandler = null
      lastRequest = null
    },
  }
}

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

export function createAIStreamingResponse(
  tokens: Array<string>,
  delayMs = 25
): MockResponse {
  const chunks = tokens.map((token) => ({
    data: JSON.stringify({ choices: [{ delta: { content: token } }] }),
  }))
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

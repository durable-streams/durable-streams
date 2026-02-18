import "dotenv/config"
import { createServer } from "node:http"
import Anthropic from "@anthropic-ai/sdk"
import type { IncomingMessage, ServerResponse } from "node:http"

const DEFAULT_MODEL = `claude-sonnet-4-20250514`

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.error(`ANTHROPIC_API_KEY is required`)
  process.exit(1)
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
const model = process.env.MODEL || DEFAULT_MODEL

async function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ``
    req.on(`data`, (chunk) => (body += chunk))
    req.on(`end`, () => resolve(body))
    req.on(`error`, reject)
  })
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader(`Access-Control-Allow-Origin`, `*`)
  res.setHeader(`Access-Control-Allow-Methods`, `POST, OPTIONS`)
  res.setHeader(`Access-Control-Allow-Headers`, `Content-Type`)
}

interface MessagePart {
  type: string
  content: string
}

interface UIMessage {
  id?: string
  role: `user` | `assistant`
  parts?: Array<MessagePart>
  content?: string
}

function getMessageContent(message: UIMessage): string {
  // Handle messages with parts array (TanStack AI format)
  if (message.parts && Array.isArray(message.parts)) {
    return message.parts
      .filter((p) => p.type === `text`)
      .map((p) => p.content)
      .join(``)
  }
  // Handle messages with direct content string
  if (typeof message.content === `string`) {
    return message.content
  }
  return ``
}

function convertMessagesToAnthropic(
  messages: Array<UIMessage>
): Array<{ role: `user` | `assistant`; content: string }> {
  return messages.map((m) => ({
    role: m.role,
    content: getMessageContent(m),
  }))
}

async function handleChat(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await parseBody(req)
    const { messages } = JSON.parse(body) as { messages: Array<UIMessage> }

    const anthropicMessages = convertMessagesToAnthropic(messages)

    setCorsHeaders(res)
    res.setHeader(`Content-Type`, `text/event-stream`)
    res.setHeader(`Cache-Control`, `no-cache`)
    res.setHeader(`Connection`, `keep-alive`)

    const stream = anthropic.messages.stream({
      model,
      max_tokens: 4096,
      messages: anthropicMessages,
    })

    const id = `msg-${Date.now()}`
    let accumulatedContent = ``

    for await (const event of stream) {
      if (event.type === `content_block_delta`) {
        const delta = event.delta
        if (`text` in delta) {
          accumulatedContent += delta.text
          const chunk = {
            type: `content`,
            id,
            model,
            timestamp: Date.now(),
            delta: delta.text,
            content: accumulatedContent,
            role: `assistant`,
          }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
      } else if (event.type === `message_stop`) {
        const doneChunk = {
          type: `done`,
          id,
          model,
          timestamp: Date.now(),
          finishReason: `stop`,
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`)
        res.write(`data: [DONE]\n\n`)
      }
    }

    res.end()
  } catch (err) {
    console.error(`Chat error:`, err)
    const errorChunk = {
      type: `error`,
      id: `error-${Date.now()}`,
      model,
      timestamp: Date.now(),
      error: { message: String(err), code: `500` },
    }
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`)
    res.write(`data: [DONE]\n\n`)
    res.end()
  }

  // Handle client disconnect
  req.on(`close`, () => {
    // Stream aborted
  })
}

const server = createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === `OPTIONS`) {
    setCorsHeaders(res)
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method === `POST` && req.url === `/api/chat`) {
    handleChat(req, res)
    return
  }

  res.statusCode = 404
  res.end(`Not found`)
})

const PORT = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT) : 3002
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

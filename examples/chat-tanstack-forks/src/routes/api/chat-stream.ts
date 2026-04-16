import { createFileRoute } from "@tanstack/react-router"
import {
  DURABLE_STREAMS_READ_HEADERS,
  buildChatStreamPath,
  buildReadStreamUrl,
} from "~/lib/durable-streams-config"

function normalizeChatId(id: string | null): string | null {
  if (!id) return null
  const trimmed = id.trim()
  if (!trimmed) return null
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null
  return trimmed
}

function copyHeaders(response: Response): Headers {
  const headers = new Headers()
  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey === `connection` || lowerKey === `transfer-encoding`) continue
    headers.set(key, value)
  }
  headers.set(`Cache-Control`, `no-store`)
  return headers
}

export const Route = createFileRoute(`/api/chat-stream`)({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const incomingUrl = new URL(request.url)
        const chatId = normalizeChatId(incomingUrl.searchParams.get(`id`))
        if (!chatId) {
          return Response.json(
            { error: `Missing or invalid chat id` },
            { status: 400 }
          )
        }
        const streamPath = buildChatStreamPath(chatId)

        const upstreamUrl = new URL(buildReadStreamUrl(streamPath))
        for (const [key, value] of incomingUrl.searchParams.entries()) {
          if (key === `id`) continue
          upstreamUrl.searchParams.append(key, value)
        }

        const accept = request.headers.get(`accept`)
        const upstreamResponse = await fetch(upstreamUrl, {
          method: `GET`,
          headers: {
            ...(accept ? { Accept: accept } : {}),
            ...(DURABLE_STREAMS_READ_HEADERS ?? {}),
          },
        })

        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: copyHeaders(upstreamResponse),
        })
      },
    },
  },
})

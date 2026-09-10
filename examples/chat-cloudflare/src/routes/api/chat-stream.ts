import { createFileRoute } from "@tanstack/react-router"
import { parseChatId } from "~/lib/chat-id"
import {
  buildChatStreamPath,
  buildStreamUrl,
  streamsFetch,
} from "~/lib/durable-streams-config"

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
        // Read proxy for durable streams: resolves the stream path from the
        // chat id server-side and forwards the response.
        const incomingUrl = new URL(request.url)
        const chatId = parseChatId(incomingUrl.searchParams.get(`id`))
        if (!chatId) {
          return Response.json(
            { error: `Missing or invalid chat id` },
            { status: 400 }
          )
        }
        const streamPath = buildChatStreamPath(chatId)

        const upstreamUrl = new URL(buildStreamUrl(streamPath))
        for (const [key, value] of incomingUrl.searchParams.entries()) {
          if (key === `id`) continue
          // Pass through offset/live/sse controls from the browser request.
          upstreamUrl.searchParams.append(key, value)
        }

        const accept = request.headers.get(`accept`)
        const upstreamResponse = await streamsFetch(upstreamUrl, {
          method: `GET`,
          headers: accept ? { Accept: accept } : {},
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

import { createFileRoute } from "@tanstack/react-router"
import { chat } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"
import {
  DURABLE_STREAMS_WRITE_HEADERS,
  buildChatStreamPath,
  buildWriteStreamUrl,
} from "~/lib/durable-streams-config"
import { onForkPointMessageWritten } from "~/lib/fork-points"

if (!process.env.OPENAI_API_KEY) {
  throw new Error(`OPENAI_API_KEY is not configured`)
}

function extractLatestUserMessage(messages: Array<any>): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === `user`) {
      return message
    }
  }
  return undefined
}

export const Route = createFileRoute(`/api/chat`)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const requestUrl = new URL(request.url)
        const requestBody = await request.json()
        const messages = requestBody.messages as Array<any>
        const idFromBody = requestBody.id as string | undefined
        const idFromQuery = requestUrl.searchParams.get(`id`)
        const id = idFromBody ?? idFromQuery ?? undefined

        if (!id) {
          return Response.json(
            { error: `Missing chat id in request body or query` },
            { status: 400 }
          )
        }

        const streamPath = buildChatStreamPath(id)
        const writeUrl = buildWriteStreamUrl(streamPath)
        const latestUserMessage = extractLatestUserMessage(messages)
        const newMessages = latestUserMessage ? [latestUserMessage] : []

        const responseStream = chat({
          adapter: openaiText(`gpt-4o-mini`),
          messages,
        })

        return toDurableChatSessionResponse({
          stream: {
            writeUrl,
            headers: DURABLE_STREAMS_WRITE_HEADERS,
          },
          newMessages,
          responseStream,
          onMessageWritten: onForkPointMessageWritten,
        })
      },
    },
  },
})

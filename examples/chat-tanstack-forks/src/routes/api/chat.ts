import { createFileRoute } from "@tanstack/react-router"
import { chat } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"
import type { WaitUntil } from "@durable-streams/tanstack-ai-transport"
import {
  DURABLE_STREAMS_WRITE_HEADERS,
  buildChatStreamPath,
  buildWriteStreamUrl,
} from "~/lib/durable-streams-config"
import { onForkPointMessageWritten } from "~/lib/fork-points"

function extractLatestUserMessage(messages: Array<any>): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === `user`) {
      return message
    }
  }
  return undefined
}

function resolveWaitUntil(
  request: Request,
  context: { waitUntil?: WaitUntil } | undefined
): WaitUntil | undefined {
  if (typeof context?.waitUntil === `function`) {
    return context.waitUntil
  }

  const req = request as Request & {
    context?: { waitUntil?: WaitUntil }
    waitUntil?: WaitUntil
  }

  if (typeof req.waitUntil === `function`) {
    return req.waitUntil
  }

  if (typeof req.context?.waitUntil === `function`) {
    return req.context.waitUntil
  }

  return undefined
}

export const Route = createFileRoute(`/api/chat`)({
  server: {
    handlers: {
      POST: async ({
        request,
        context,
      }: {
        request: Request
        context?: { waitUntil?: WaitUntil }
      }) => {
        if (!process.env.OPENAI_API_KEY) {
          return Response.json(
            { error: `OPENAI_API_KEY is not configured` },
            { status: 500 }
          )
        }

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
        const waitUntil = resolveWaitUntil(request, context)

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
          waitUntil,
        })
      },
    },
  },
} as never)

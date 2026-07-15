import { createFileRoute } from "@tanstack/react-router"
import { chat } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"
import {
  DURABLE_STREAMS_WRITE_HEADERS,
  buildChatStreamPath,
  buildWriteStreamUrl,
} from "~/lib/durable-streams-config"
import { saveChatMessages } from "~/lib/chat-store"
import { assertValidChatId } from "~/lib/chat-id"
import { requireAuth } from "~/lib/auth.server"

function extractLatestUserMessage(messages: Array<any>): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === `user`) {
      return message
    }
  }
  return undefined
}

export async function handleChatPost({ request }: { request: Request }) {
  const unauthorized = requireAuth(request)
  if (unauthorized) return unauthorized
  const requestUrl = new URL(request.url)
  const requestBody = await request.json()
  const messages = requestBody.messages as Array<any>
  const idFromBody = requestBody.id as string | undefined
  const idFromQuery = requestUrl.searchParams.get(`id`)
  const id = idFromBody ?? idFromQuery ?? undefined

  try {
    assertValidChatId(id)
  } catch {
    return Response.json({ error: `Invalid chat id` }, { status: 400 })
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(`OPENAI_API_KEY is not configured`)
  }

  // Durable session model: one append-only stream per chat id.
  const streamPath = buildChatStreamPath(id)
  const writeUrl = buildWriteStreamUrl(streamPath)
  // Explicitly append only the new prompt message for this request.
  const latestUserMessage = extractLatestUserMessage(messages)
  const newMessages = latestUserMessage ? [latestUserMessage] : []

  // Keep lightweight local metadata (title/listing), not full transcript storage.
  await saveChatMessages({ id, messages })

  // Start model generation; chunks are piped to the same durable stream.
  const responseStream = chat({
    adapter: openaiText(`gpt-4o-mini`),
    messages,
  })

  // Helper appends newMessages, streams response chunks, and returns stream URL.
  return toDurableChatSessionResponse({
    stream: {
      writeUrl,
      headers: DURABLE_STREAMS_WRITE_HEADERS,
    },
    newMessages,
    responseStream,
  })
}

export const Route = createFileRoute(`/api/chat`)({
  server: { handlers: { POST: handleChatPost } },
})

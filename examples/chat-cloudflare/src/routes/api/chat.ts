import { waitUntil } from "cloudflare:workers"
import { createFileRoute } from "@tanstack/react-router"
import { chat } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"
import { streamsFetch } from "~/lib/durable-streams-config"
import { resolveChatRequest } from "~/lib/chat-request"
import { saveChatMessages } from "~/lib/chat-store"

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
        const resolved = await resolveChatRequest(request)
        if (!resolved.ok) return resolved.response
        const { id, messages, writeUrl } = resolved
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
            fetchClient: streamsFetch,
          },
          newMessages,
          responseStream,
          // The 202 returns before generation finishes; without waitUntil,
          // workerd cancels the orphaned pipe when the request context ends
          // and no assistant chunks are ever written.
          waitUntil,
        })
      },
    },
  },
})

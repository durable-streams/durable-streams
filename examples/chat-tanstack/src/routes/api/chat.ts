import { createFileRoute } from "@tanstack/react-router"
import { chat, toServerSentEventsResponse } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { saveChatMessages } from "~/lib/chat-store"

if (!process.env.OPENAI_API_KEY) {
  throw new Error(`OPENAI_API_KEY is not configured`)
}

export const Route = createFileRoute(`/api/chat`)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const requestBody = await request.json()
        const messages = requestBody.messages as Array<any>
        const idFromBody = requestBody.id as string | undefined
        const idFromQuery = new URL(request.url).searchParams.get(`id`)
        const id = idFromBody ?? idFromQuery ?? undefined

        if (!id) {
          return Response.json(
            { error: `Missing chat id in request body or query` },
            { status: 400 }
          )
        }

        await saveChatMessages({ id, messages })

        const stream = chat({
          adapter: openaiText(`gpt-4o-mini`),
          messages,
        })

        return toServerSentEventsResponse(stream)
      },
    },
  },
})

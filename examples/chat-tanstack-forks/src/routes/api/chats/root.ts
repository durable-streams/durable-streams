import { createFileRoute } from "@tanstack/react-router"
import { createRootChatSession } from "~/lib/chat-session.server"

export const Route = createFileRoute(`/api/chats/root`)({
  server: {
    handlers: {
      POST: async () => {
        try {
          const result = await createRootChatSession()
          return Response.json(result)
        } catch (error) {
          console.error(`Failed to create root chat`, error)
          return Response.json(
            { error: `Failed to create root chat` },
            { status: 500 }
          )
        }
      },
    },
  },
})

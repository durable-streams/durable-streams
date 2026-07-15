import { createFileRoute } from "@tanstack/react-router"
import { requireAuth } from "~/lib/auth.server"

export const Route = createFileRoute(`/api/chats`)({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = requireAuth(request)
        if (unauthorized) return unauthorized
        const { listChats } = await import(`~/lib/chat-store`)
        const chats = await listChats()
        return Response.json(chats)
      },
    },
  },
})

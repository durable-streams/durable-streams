import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(`/api/chats`)({
  server: {
    handlers: {
      GET: async () => {
        const { listChats } = await import(`~/lib/chat-store`)
        const chats = await listChats()
        return Response.json(chats)
      },
    },
  },
})

import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { createChatSession } from "~/lib/chat-session.server"

const newChat = createServerFn().handler(async () => {
  return createChatSession()
})

export const Route = createFileRoute(`/chat/`)({
  loader: async () => {
    const id = await newChat()
    throw redirect({ to: `/chat/$id`, params: { id } })
  },
})

import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { Chat } from "~/components/chat"
import { loadChatSession } from "~/lib/chat-session.server"

const getChatData = createServerFn({ method: `GET` })
  .inputValidator((id: string) => id)
  .handler(async ({ data }) => loadChatSession(data))

export const Route = createFileRoute(`/chat/$id`)({
  loader: async ({ params }) => {
    const chat = await getChatData({ data: params.id })
    if (!chat) {
      throw redirect({ to: `/chat` })
    }
    return chat
  },
  component: ChatPage,
  staleTime: 0,
})

function ChatPage() {
  const { id } = Route.useParams()
  const chat = Route.useLoaderData()

  return (
    <Chat
      key={id}
      id={id}
      initialMessages={chat.messages}
      resumeOffset={chat.resumeOffset}
    />
  )
}

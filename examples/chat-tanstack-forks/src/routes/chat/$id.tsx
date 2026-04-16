import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useEffect } from "react"
import { Chat } from "~/components/chat"
import { loadChatSession } from "~/lib/chat-session.server"
import { loadTree } from "~/lib/chat-tree"

const getChatData = createServerFn({ method: `GET` })
  .inputValidator((id: string) => id)
  .handler(async ({ data }) => loadChatSession(data))

export const getForkPointsFromServer = createServerFn({ method: `GET` })
  .inputValidator((id: string) => id)
  .handler(async ({ data }) => {
    const session = await loadChatSession(data)
    const points: Record<string, string> = {}
    for (const msg of session.messages) {
      const endOffset = msg.metadata?.durable?.endOffset
      if (typeof endOffset === `string`) {
        points[msg.id] = endOffset
      }
    }
    return points
  })

function extractForkPoints(messages: Array<any>): Record<string, string> {
  const points: Record<string, string> = {}
  for (const msg of messages) {
    const endOffset = msg?.metadata?.durable?.endOffset
    if (typeof endOffset === `string`) {
      points[msg.id] = endOffset
    }
  }
  return points
}

export const Route = createFileRoute(`/chat/$id`)({
  loader: async ({ params }) => {
    const chat = await getChatData({ data: params.id })
    return {
      ...chat,
      initialForkPoints: extractForkPoints(chat.messages),
    }
  },
  component: ChatPage,
  staleTime: 0,
})

function ChatPage() {
  const { id } = Route.useParams()
  const chat = Route.useLoaderData()
  const navigate = useNavigate()

  const knownChat = typeof window !== `undefined` && !!loadTree().chatsById[id]

  useEffect(() => {
    if (!knownChat) {
      navigate({ to: `/` })
    }
  }, [knownChat, navigate])

  if (!knownChat) return null

  return (
    <Chat
      key={id}
      id={id}
      initialMessages={chat.messages}
      resumeOffset={chat.resumeOffset}
      initialForkPoints={chat.initialForkPoints}
    />
  )
}

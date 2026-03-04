import { redirect } from "next/navigation"
import { loadChat } from "../../lib/chat-store"
import { Chat } from "../../components/chat"

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  let chat
  try {
    chat = await loadChat(id)
  } catch {
    redirect(`/chat`)
  }

  return <Chat id={id} initialMessages={chat.messages} />
}

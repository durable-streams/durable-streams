import { redirect } from "next/navigation"
import { createChat } from "../lib/chat-store"

export default async function NewChatPage() {
  const id = await createChat()
  redirect(`/chat/${id}`)
}

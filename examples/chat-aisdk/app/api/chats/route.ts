import { listChats } from "../../lib/chat-store"

export const dynamic = `force-dynamic`

export async function GET() {
  const chats = await listChats()
  return Response.json(chats)
}

import { listChats } from "../../lib/chat-store"
import { requireAuth } from "../../lib/auth"

export const dynamic = `force-dynamic`

export async function GET(request: Request) {
  const unauthorized = requireAuth(request)
  if (unauthorized) return unauthorized
  const chats = await listChats()
  return Response.json(chats)
}

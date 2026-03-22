import { loadChat } from "../../../../lib/chat-store"
import { buildReadProxyUrl } from "../../../../utils"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  let chat
  try {
    chat = await loadChat(id)
  } catch {
    return new Response(null, { status: 204 })
  }

  if (!chat.activeStreamId) {
    return new Response(null, { status: 204 })
  }

  const streamUrl = buildReadProxyUrl(request, chat.activeStreamId)
  return Response.json(
    { streamUrl },
    { status: 200, headers: { Location: streamUrl } }
  )
}

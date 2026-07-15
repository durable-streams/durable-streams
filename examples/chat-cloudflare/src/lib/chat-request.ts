import { parseChatId } from "./chat-id"
import { buildChatStreamPath, buildStreamUrl } from "./chat-paths"

export async function resolveChatRequest(
  request: Request,
  parse: (value: unknown) => string | null = parseChatId
): Promise<
  | {
      ok: true
      id: string
      messages: Array<any>
      streamPath: string
      writeUrl: string
    }
  | { ok: false; response: Response }
> {
  const body = (await request.json()) as Record<string, unknown>
  const queryId = new URL(request.url).searchParams.get(`id`)
  const id = parse(body.id ?? queryId)
  if (!id) {
    return {
      ok: false,
      response: Response.json(
        { error: `Missing chat id in request body or query` },
        { status: 400 }
      ),
    }
  }
  const streamPath = buildChatStreamPath(id)
  return {
    ok: true,
    id,
    messages: body.messages as Array<any>,
    streamPath,
    writeUrl: buildStreamUrl(streamPath),
  }
}

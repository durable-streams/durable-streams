const INTERNAL_BASE_URL = `http://streams.internal/streams`

export function buildStreamUrl(streamPath: string): string {
  return new URL(
    streamPath.replace(/^\/+/, ``),
    `${INTERNAL_BASE_URL}/`
  ).toString()
}

export function buildChatStreamPath(chatId: string): string {
  return `chat/${chatId}`
}

function withProtocol(url: string): string {
  return url.includes(`://`) ? url : `http://${url}`
}

function authHeader(token?: string): { Authorization: string } | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

const DEFAULT_DURABLE_STREAMS_URL = `http://localhost:4437`
const SHARED_URL =
  process.env.DURABLE_STREAMS_URL ?? DEFAULT_DURABLE_STREAMS_URL
const DURABLE_STREAMS_WRITE_URL = withProtocol(
  process.env.DURABLE_STREAMS_WRITE_URL ?? SHARED_URL
)
const DURABLE_STREAMS_READ_URL = withProtocol(
  process.env.DURABLE_STREAMS_READ_URL ?? SHARED_URL
)

export const DURABLE_STREAMS_WRITE_HEADERS = authHeader(
  process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN
)

export const DURABLE_STREAMS_READ_HEADERS =
  authHeader(process.env.DURABLE_STREAMS_READ_BEARER_TOKEN) ??
  authHeader(process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN)

function buildStreamUrl(baseUrl: string, streamPath: string): string {
  return new URL(
    streamPath.replace(/^\/+/, ``),
    `${baseUrl.replace(/\/+$/, ``)}/`
  ).toString()
}

export function buildWriteStreamUrl(streamPath: string): string {
  return buildStreamUrl(DURABLE_STREAMS_WRITE_URL, streamPath)
}

export function buildReadStreamUrl(streamPath: string): string {
  return buildStreamUrl(DURABLE_STREAMS_READ_URL, streamPath)
}

export function buildChatStreamPath(chatId: string): string {
  return `chat/${chatId}`
}

import {
  DurableStream,
  DurableStreamError,
  stream,
} from "@durable-streams/client"
import type { ChatSummary } from "~/lib/chat-types"
import { buildStreamUrl, streamsFetch } from "~/lib/durable-streams-config"

// Workers have no filesystem, so chat metadata is itself a durable stream:
// an append-only JSON log of {id, title, createdAt} records where the last
// record per id wins.
const INDEX_STREAM_PATH = `chats/index`
const JSON_CONTENT_TYPE = `application/json`

type ChatData = ChatSummary

async function indexStream(): Promise<DurableStream> {
  const durableStream = new DurableStream({
    url: buildStreamUrl(INDEX_STREAM_PATH),
    contentType: JSON_CONTENT_TYPE,
    fetch: streamsFetch,
  })
  try {
    await durableStream.create({ contentType: JSON_CONTENT_TYPE })
  } catch (error) {
    const alreadyExists =
      error instanceof DurableStreamError && error.status === 409
    if (!alreadyExists) throw error
  }
  return durableStream
}

async function readIndex(): Promise<Array<ChatData>> {
  try {
    const response = await stream<ChatData>({
      url: buildStreamUrl(INDEX_STREAM_PATH),
      json: true,
      live: false,
      fetch: streamsFetch,
    })
    return await response.json<ChatData>()
  } catch (error) {
    if (error instanceof DurableStreamError && error.status === 404) return []
    throw error
  }
}

async function appendRecord(data: ChatData): Promise<void> {
  const durableStream = await indexStream()
  await durableStream.append(JSON.stringify(data), {
    contentType: JSON_CONTENT_TYPE,
  })
}

/** Creates a new chat metadata record and returns its id. */
export async function createChat(): Promise<string> {
  const id = crypto.randomUUID()
  const data: ChatData = {
    id,
    createdAt: new Date().toISOString(),
    title: `New chat`,
  }
  await appendRecord(data)
  return id
}

/** Loads chat metadata, or null when the chat is unknown. */
export async function loadChatIfExists(id: string): Promise<ChatData | null> {
  const records = await readIndex()
  let latest: ChatData | null = null
  for (const record of records) {
    if (record.id === id) latest = record
  }
  return latest
}

async function upsertChatTitle(id: string, title: string): Promise<void> {
  const existing = await loadChatIfExists(id)
  await appendRecord({
    id,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    title,
  })
}

type TitleMessage = {
  role?: string
  parts?: Array<{ type?: string; content?: string }>
}

function deriveTitle(messages: Array<TitleMessage>): string {
  const first = messages.find((m) => m.role === `user`)
  if (!first) return `New chat`
  const text = (first.parts ?? [])
    .filter((p) => p.type === `text`)
    .map((p) => p.content ?? ``)
    .join(``)
  if (text.length <= 40) return text
  return text.slice(0, 40) + `…`
}

/** Updates chat title based on the first user message in the request. */
export async function saveChatMessages({
  id,
  messages,
}: {
  id: string
  messages: Array<TitleMessage>
}): Promise<void> {
  await upsertChatTitle(id, deriveTitle(messages))
}

/** Lists chat metadata for the sidebar, newest first. */
export async function listChats(): Promise<Array<ChatSummary>> {
  const records = await readIndex()
  const byId = new Map<string, ChatData>()
  for (const record of records) {
    byId.set(record.id, record)
  }
  const chats = [...byId.values()]
  chats.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return chats
}

import {
  ensureDurableChatSessionStream,
  materializeSnapshotFromDurableStream,
} from "@durable-streams/tanstack-ai-transport"
import { createChat, loadChatIfExists } from "~/lib/chat-store"
import {
  DURABLE_STREAMS_READ_HEADERS,
  DURABLE_STREAMS_WRITE_HEADERS,
  buildChatStreamPath,
  buildReadStreamUrl,
  buildWriteStreamUrl,
  streamsFetch,
} from "~/lib/durable-streams-config"

/** Creates local metadata and the durable stream for a new chat session. */
export async function createChatSession(): Promise<string> {
  const id = await createChat()
  await ensureDurableChatSessionStream({
    writeUrl: buildWriteStreamUrl(buildChatStreamPath(id)),
    headers: DURABLE_STREAMS_WRITE_HEADERS,
    fetchClient: streamsFetch,
  })
  return id
}

/** Loads chat metadata and hydrates message snapshot from durable storage. */
export async function loadChatSession(chatId: string) {
  const chatMetadata = await loadChatIfExists(chatId)
  if (!chatMetadata) return null

  await ensureDurableChatSessionStream({
    writeUrl: buildWriteStreamUrl(buildChatStreamPath(chatId)),
    headers: DURABLE_STREAMS_WRITE_HEADERS,
    fetchClient: streamsFetch,
  })
  const streamPath = buildChatStreamPath(chatId)

  try {
    const snapshot = await materializeSnapshotFromDurableStream({
      readUrl: buildReadStreamUrl(streamPath),
      headers: DURABLE_STREAMS_READ_HEADERS,
      fetchClient: streamsFetch,
    })
    return {
      ...chatMetadata,
      messages: snapshot.messages,
      resumeOffset: snapshot.offset,
    }
  } catch (error) {
    console.warn(
      `Failed to materialize durable snapshot for chat`,
      chatId,
      error
    )
    return {
      ...chatMetadata,
      messages: [],
      resumeOffset: undefined,
    }
  }
}

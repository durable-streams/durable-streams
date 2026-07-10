import {
  ensureDurableChatSessionStream,
  materializeSnapshotFromDurableStream,
} from "@durable-streams/tanstack-ai-transport"
import { createChat, loadChatIfExists } from "~/lib/chat-store"
import {
  buildChatStreamPath,
  buildStreamUrl,
  streamsFetch,
} from "~/lib/durable-streams-config"

/** Creates local metadata and the durable stream for a new chat session. */
export async function createChatSession(): Promise<string> {
  const id = await createChat()
  await ensureDurableChatSessionStream({
    writeUrl: buildStreamUrl(buildChatStreamPath(id)),
    fetchClient: streamsFetch,
  })
  return id
}

/** Loads chat metadata and hydrates message snapshot from durable storage. */
export async function loadChatSession(chatId: string) {
  const chatMetadata = await loadChatIfExists(chatId)
  if (!chatMetadata) return null

  const streamPath = buildChatStreamPath(chatId)
  await ensureDurableChatSessionStream({
    writeUrl: buildStreamUrl(streamPath),
    fetchClient: streamsFetch,
  })

  try {
    const snapshot = await materializeSnapshotFromDurableStream({
      readUrl: buildStreamUrl(streamPath),
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

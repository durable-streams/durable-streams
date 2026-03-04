import { createChat, loadChatIfExists } from "~/lib/chat-store"

/** Creates local metadata for a new chat session. */
export async function createChatSession(): Promise<string> {
  return createChat()
}

/** Loads chat metadata for the session page. */
export async function loadChatSession(chatId: string) {
  const chatMetadata = await loadChatIfExists(chatId)
  if (!chatMetadata) return null

  return {
    ...chatMetadata,
    messages: [],
    resumeOffset: undefined,
  }
}

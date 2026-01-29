import type { UIMessage } from "@tanstack/ai-react"

/** Get the localStorage key for messages of a conversation */
export function getMessagesKey(conversationId: string): string {
  return `${conversationId}-messages`
}

/** Load messages from localStorage */
export function loadMessages(conversationId: string): Array<UIMessage> {
  try {
    const stored = localStorage.getItem(getMessagesKey(conversationId))
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    console.error(`Failed to load messages from localStorage`)
  }
  return []
}

/** Save messages to localStorage */
export function saveMessages(
  conversationId: string,
  messages: Array<UIMessage>
): void {
  try {
    localStorage.setItem(
      getMessagesKey(conversationId),
      JSON.stringify(messages)
    )
  } catch {
    console.error(`Failed to save messages to localStorage`)
  }
}

/** Get all conversation IDs from localStorage */
export function getAllConversations(): Array<string> {
  const conversations = new Set<string>()
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(`conv-`)) {
      // Extract conversation ID from keys like "conv-xxx-messages" or "conv-xxx-messageCount"
      const match = key.match(/^(conv-[a-z0-9]+)/)
      if (match) {
        conversations.add(match[1])
      }
    }
  }
  return Array.from(conversations).sort()
}

/** Generate a short random ID */
export function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Get conversation ID from URL hash or return empty string */
export function getConversationIdFromUrl(): string {
  const hash = window.location.hash.slice(1) // Remove #
  if (hash && hash.startsWith(`conv-`)) {
    return hash
  }
  return ``
}

/** Update URL hash with conversation ID */
export function setConversationIdInUrl(id: string): void {
  window.history.replaceState(null, ``, `#${id}`)
}

/** Delete a conversation - clears localStorage and aborts any active streams */
export async function deleteConversation(
  conversationId: string,
  proxyUrl: string
): Promise<void> {
  // Storage key format: durable-streams:${proxyUrl}:${conversationId}-msg-${num}
  const storagePrefix = `durable-streams:${proxyUrl}:`

  // Find all stream credentials for this conversation and abort them
  const streamKeys = Object.keys(localStorage).filter(
    (k) => k.startsWith(storagePrefix) && k.includes(`${conversationId}-msg-`)
  )

  for (const key of streamKeys) {
    try {
      const credentials = JSON.parse(localStorage.getItem(key) || `{}`)
      if (credentials.readToken) {
        // Extract stream key from storage key (after the prefix)
        const streamKey = key.slice(storagePrefix.length)
        const proxyBase = proxyUrl.replace(/\/v1\/proxy\/[^/]+\/?$/, ``)
        const serviceName =
          proxyUrl.match(/\/v1\/proxy\/([^/]+)/)?.[1] || `chat`
        const abortUrl = `${proxyBase}/v1/proxy/${serviceName}/streams/${streamKey}/abort`

        try {
          await fetch(abortUrl, {
            method: `POST`,
            headers: {
              Authorization: `Bearer ${credentials.readToken}`,
            },
          })
        } catch {
          // Ignore abort errors
        }
      }
      localStorage.removeItem(key)
    } catch {
      // Ignore errors
    }
  }

  // Remove all localStorage entries for this conversation (messages, messageCount, etc.)
  const keysToRemove = Object.keys(localStorage).filter((k) =>
    k.startsWith(conversationId)
  )

  for (const key of keysToRemove) {
    localStorage.removeItem(key)
  }
}

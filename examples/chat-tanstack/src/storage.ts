import type { UIMessage } from "@tanstack/ai-react"

const CONVERSATIONS_KEY = `chat-conversations`
const MESSAGES_PREFIX = `chat-messages-`

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function getConversations(): Array<Conversation> {
  const raw = localStorage.getItem(CONVERSATIONS_KEY)
  if (!raw) return []
  try {
    const conversations: Array<Conversation> = JSON.parse(raw)
    return conversations.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function saveConversations(conversations: Array<Conversation>) {
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations))
}

export function createConversation(): Conversation {
  const conversation: Conversation = {
    id: generateId(),
    title: `New chat`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const conversations = getConversations()
  conversations.unshift(conversation)
  saveConversations(conversations)
  return conversation
}

export function deleteConversation(id: string) {
  const conversations = getConversations().filter((c) => c.id !== id)
  saveConversations(conversations)
  localStorage.removeItem(MESSAGES_PREFIX + id)
}

export function getMessages(conversationId: string): Array<UIMessage> {
  const raw = localStorage.getItem(MESSAGES_PREFIX + conversationId)
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

export function saveMessages(
  conversationId: string,
  messages: Array<UIMessage>
) {
  localStorage.setItem(
    MESSAGES_PREFIX + conversationId,
    JSON.stringify(messages)
  )

  // Update conversation title and timestamp
  const conversations = getConversations()
  const conversation = conversations.find((c) => c.id === conversationId)
  if (conversation) {
    conversation.updatedAt = Date.now()
    if (conversation.title === `New chat` && messages.length > 0) {
      const firstUserMessage = messages.find((m) => m.role === `user`)
      if (firstUserMessage) {
        const text = firstUserMessage.parts
          .filter(
            (p): p is { type: `text`; content: string } => p.type === `text`
          )
          .map((p) => p.content)
          .join(``)
        if (text) {
          conversation.title =
            text.length > 50 ? text.slice(0, 50) + `...` : text
        }
      }
    }
    saveConversations(conversations)
  }
}

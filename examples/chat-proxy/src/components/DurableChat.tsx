import { useCallback, useEffect, useState } from "react"
import {
  generateId,
  getConversationIdFromUrl,
  loadMessages,
  setConversationIdInUrl,
} from "../lib/storage"
import { Sidebar } from "./Sidebar"
import { ChatInterface } from "./ChatInterface"
import type { UIMessage } from "@tanstack/ai-react"
import "../styles/chat.css"

interface DurableChatProps {
  /** URL of the durable proxy server */
  proxyUrl: string
  /** URL of the backend API server */
  apiUrl: string
}

/**
 * Chat component using Durable Proxy transport.
 */
export function DurableChat({ proxyUrl, apiUrl }: DurableChatProps) {
  const [conversationId, setConversationId] = useState<string>(``)
  const [initialMessageCount, setInitialMessageCount] = useState(0)
  const [initialMessages, setInitialMessages] = useState<Array<UIMessage>>([])
  const [isInitialized, setIsInitialized] = useState(false)
  const [hasMessages, setHasMessages] = useState(false)

  useEffect(() => {
    let id = getConversationIdFromUrl()
    if (!id) {
      id = `conv-${generateId()}`
      setConversationIdInUrl(id)
    }
    setConversationId(id)

    const storedCount = localStorage.getItem(`${id}-messageCount`)
    if (storedCount) {
      setInitialMessageCount(parseInt(storedCount, 10))
    }

    const messages = loadMessages(id)
    if (messages.length > 0) {
      setInitialMessages(messages)
      setHasMessages(true)
    }

    setIsInitialized(true)
  }, [])

  const handleNewConversation = useCallback(() => {
    const newId = `conv-${generateId()}`
    setConversationIdInUrl(newId)
    window.location.reload()
  }, [])

  const handleSelectConversation = useCallback(
    (id: string) => {
      if (id !== conversationId) {
        setConversationIdInUrl(id)
        window.location.reload()
      }
    },
    [conversationId]
  )

  const handleMessagesUpdated = useCallback(() => {
    setHasMessages(true)
  }, [])

  if (!isInitialized || !conversationId) {
    return (
      <div className="chat-wrapper">
        <div className="chat-container">
          <p>Initializing...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-wrapper">
      <Sidebar
        currentConversationId={conversationId}
        proxyUrl={proxyUrl}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        currentConversationHasMessages={hasMessages}
      />
      <div className="chat-main-content">
        <ChatInterface
          key={conversationId}
          conversationId={conversationId}
          apiUrl={apiUrl}
          proxyUrl={proxyUrl}
          initialMessageCount={initialMessageCount}
          initialMessages={initialMessages}
          onMessagesUpdated={handleMessagesUpdated}
        />
      </div>
    </div>
  )
}

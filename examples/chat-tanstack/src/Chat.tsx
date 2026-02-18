import { useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@tanstack/ai-react"
import { createDurableAdapter } from "@durable-streams/proxy/transports"
import { getMessages, saveMessages } from "./storage"
import type { UIMessage } from "@tanstack/ai-react"
import type { FormEvent, KeyboardEvent } from "react"

// Helper to extract text content from UIMessage parts
function getMessageContent(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is { type: `text`; content: string } => part.type === `text`
    )
    .map((part) => part.content)
    .join(``)
}

interface ChatProps {
  conversationId: string
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onMessagesChange?: () => void
}

const PROXY_URL =
  import.meta.env.VITE_PROXY_URL || `http://localhost:4440/v1/proxy`
const PROXY_SECRET = import.meta.env.VITE_PROXY_SECRET || `dev-secret`
const UPSTREAM_URL =
  import.meta.env.VITE_UPSTREAM_URL || `http://localhost:3002/api/chat`

export function Chat({
  conversationId,
  sidebarOpen,
  onToggleSidebar,
  onMessagesChange,
}: ChatProps) {
  const [input, setInput] = useState(``)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const initialMessages = useMemo(
    () => getMessages(conversationId),
    [conversationId]
  )

  // Create a durable adapter that routes through the proxy for resumable streaming.
  // The requestId is scoped per conversation turn so each assistant response
  // gets its own durable stream that can be resumed on page refresh.
  const connection = useMemo(
    () =>
      createDurableAdapter(UPSTREAM_URL, {
        proxyUrl: PROXY_URL,
        proxyAuthorization: PROXY_SECRET,
        getRequestId: (messages) => `${conversationId}-turn-${messages.length}`,
      }) as any,
    [conversationId]
  )

  const { messages, sendMessage, isLoading, error, stop, reload } = useChat({
    connection,
    initialMessages,
  })

  // Persist messages to localStorage on every change
  const prevLengthRef = useRef(0)
  useEffect(() => {
    if (messages.length > 0) {
      saveMessages(conversationId, messages)
      // Only notify sidebar when message count changes (not during streaming deltas)
      if (messages.length !== prevLengthRef.current) {
        prevLengthRef.current = messages.length
        onMessagesChange?.()
      }
    }
  }, [messages, conversationId, onMessagesChange])

  // Auto-scroll to bottom while streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: `smooth` })
  }, [messages])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = `auto`
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 120) + `px`
    }
  }, [input])

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (input.trim() && !isLoading) {
      sendMessage(input.trim())
      setInput(``)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === `Enter` && !e.shiftKey) {
      e.preventDefault()
      if (input.trim() && !isLoading) {
        sendMessage(input.trim())
        setInput(``)
      }
    }
  }

  const handleRetry = () => {
    reload()
  }

  return (
    <div className="chat-container">
      <header className="chat-header">
        <button className="sidebar-toggle" onClick={onToggleSidebar}>
          {sidebarOpen ? `\u2190` : `\u2192`}
        </button>
        <span>Chat</span>
      </header>

      <main className="chat-messages">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={`message ${message.role} ${
              message.role === `assistant` &&
              isLoading &&
              index === messages.length - 1
                ? `streaming`
                : ``
            }`}
          >
            {getMessageContent(message)}
          </div>
        ))}

        {error && (
          <div className="error-banner">
            <span>Error: {error.message || `Something went wrong`}</span>
            <button onClick={handleRetry}>Retry</button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      <form className="chat-composer" onSubmit={onSubmit}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message..."
          rows={1}
        />
        {isLoading ? (
          <button type="button" className="stop" onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="send" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@tanstack/ai-react"
import { createDurableConnection } from "../lib/durableConnection"
import { saveMessages } from "../lib/storage"
import { resumeStream } from "../lib/streamResume"
import type { UIMessage } from "@tanstack/ai-react"
import "../styles/chat.css"

function getMessageText(
  parts: Array<{ type: string; content?: string }>
): string {
  return parts
    .filter((part) => part.type === `text`)
    .map((part) => part.content || ``)
    .join(``)
}

interface ChatInterfaceProps {
  conversationId: string
  apiUrl: string
  proxyUrl: string
  initialMessageCount: number
  initialMessages: Array<UIMessage>
  onMessagesUpdated?: () => void
}

export function ChatInterface({
  conversationId,
  apiUrl,
  proxyUrl,
  initialMessageCount,
  initialMessages,
  onMessagesUpdated,
}: ChatInterfaceProps) {
  const [input, setInput] = useState(``)
  const [messageCount, setMessageCount] = useState(initialMessageCount)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Use ref for messageCount so getStreamKey doesn't cause connection recreation
  const messageCountRef = useRef(messageCount)
  useEffect(() => {
    messageCountRef.current = messageCount
  }, [messageCount])

  // Save message count when it changes
  useEffect(() => {
    if (messageCount > 0) {
      localStorage.setItem(
        `${conversationId}-messageCount`,
        messageCount.toString()
      )
    }
  }, [conversationId, messageCount])

  // Get current stream key - reads from ref
  const getStreamKey = useCallback(() => {
    return `${conversationId}-msg-${messageCountRef.current}`
  }, [conversationId])

  // Create durable connection adapter - stable reference
  const connection = useMemo(() => {
    return createDurableConnection(apiUrl, proxyUrl, getStreamKey)
  }, [apiUrl, proxyUrl, conversationId, getStreamKey])

  const { messages, sendMessage, setMessages, isLoading, error } = useChat({
    connection,
    initialMessages,
  })

  // Track if we're doing a manual resume
  const [isResuming, setIsResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)

  // Auto-scroll to bottom when messages change or during loading/resuming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: `smooth` })
  }, [messages, isLoading, isResuming])

  // Save messages whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      saveMessages(conversationId, messages)
      onMessagesUpdated?.()
    }
  }, [conversationId, messages, onMessagesUpdated])

  // On mount, check if we need to resume an incomplete stream
  const hasAttemptedResume = useRef(false)
  useEffect(() => {
    if (hasAttemptedResume.current || isLoading) return

    // Wait for useChat to have messages before attempting resume
    if (initialMessages.length > 0 && messages.length === 0) {
      return
    }

    // Find the highest cardinality stream for this conversation
    const allKeys = Object.keys(localStorage)
    const conversationStreams = allKeys
      .filter((k) => k.startsWith(`durable-streams:${conversationId}-msg-`))
      .map((k) => {
        const match = k.match(/-msg-(\d+)$/)
        return match ? { key: k, num: parseInt(match[1], 10) } : null
      })
      .filter((x): x is { key: string; num: number } => x !== null)
      .sort((a, b) => b.num - a.num)

    if (conversationStreams.length === 0) return

    const highestStream = conversationStreams[0]

    const credentials = localStorage.getItem(highestStream.key)
    let streamUrl = ``
    let credentialsData: {
      offset?: string
      path?: string
      readToken?: string
    } = {}

    if (credentials) {
      try {
        credentialsData = JSON.parse(credentials)
        streamUrl = `${proxyUrl.replace(`/v1/proxy/chat`, ``)}/v1/proxy/chat/streams/${conversationId}-msg-${highestStream.num}?offset=${credentialsData.offset || `-1`}&live=sse`
      } catch {
        // Ignore parse errors for corrupted credentials
      }
    }

    // Update messageCount to match highest stream if different
    if (highestStream.num !== messageCount) {
      messageCountRef.current = highestStream.num
      setMessageCount(highestStream.num)
    }

    // Always reconnect if we have credentials for the highest stream
    if (credentials && credentialsData.readToken) {
      hasAttemptedResume.current = true

      setIsResuming(true)
      resumeStream(
        streamUrl,
        credentialsData.readToken,
        highestStream.key,
        messages,
        setMessages
      )
        .then(() => {
          setIsResuming(false)
          setResumeError(null)
        })
        .catch((err: Error) => {
          setIsResuming(false)
          setResumeError(err.message)
        })
    }
  }, [
    conversationId,
    messageCount,
    initialMessages,
    messages,
    isLoading,
    proxyUrl,
    setMessages,
  ])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (input.trim() && !isLoading) {
      const newCount = messageCount + 1
      messageCountRef.current = newCount
      setMessageCount(newCount)
      sendMessage(input)
      setInput(``)
    }
  }

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1 className="chat-title">TanStack AI + Durable Proxy Chat</h1>
      </div>

      <div className="chat-messages-container">
        {messages.length === 0 && (
          <p className="chat-messages-empty-state">
            Send a message to start chatting!
          </p>
        )}
        {messages.map((message) => {
          const text = getMessageText(message.parts)
          // Don't show assistant message until first token arrives
          if (message.role === `assistant` && !text) return null
          return (
            <div
              key={message.id}
              className={`chat-message ${message.role === `assistant` ? `chat-message--assistant` : `chat-message--user`}`}
            >
              <strong>{message.role === `assistant` ? `Agent` : `You`}:</strong>
              <p className="chat-message-content">{text}</p>
            </div>
          )
        })}
        {(isLoading || isResuming) && (
          <div className="chat-loading-container">
            <div className="chat-loading-spinner" />
            <span className="chat-loading-text">Thinking...</span>
          </div>
        )}
        {(error || resumeError) && (
          <div className="chat-error">
            <strong>Error:</strong> {error?.message || resumeError}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="chat-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          className="chat-input"
          disabled={isLoading}
        />
        <button
          type="submit"
          className="chat-submit-button"
          disabled={isLoading || !input.trim()}
        >
          Send
        </button>
      </form>
    </div>
  )
}

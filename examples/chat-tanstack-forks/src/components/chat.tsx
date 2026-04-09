"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@tanstack/ai-react"
import { durableStreamConnection } from "@durable-streams/tanstack-ai-transport"
import type { ForkMarkerInfo } from "~/components/chat-message-actions"
import type { ChatTreeState } from "~/lib/chat-tree"
import type { UIMessage } from "@tanstack/ai-react"
import { ChatHeader } from "~/components/chat-header"
import { ForkButton, ForkPointMarker } from "~/components/chat-message-actions"
import {
  deriveTitleFromMessages,
  loadTree,
  saveTree,
  setActiveChat,
  updateTitle,
} from "~/lib/chat-tree"
import { forkPointCustomChunkHandler } from "~/lib/fork-points"
import { getForkPointsFromServer } from "~/routes/chat/$id"

function computeForkMarkers(
  tree: ChatTreeState,
  chatId: string
): Record<string, Array<ForkMarkerInfo>> {
  const markers: Record<string, Array<ForkMarkerInfo>> = {}
  const node = tree.chatsById[chatId]
  if (!node) return markers

  for (const childId of node.childIds) {
    const child = tree.chatsById[childId]
    if (!child?.forkedFromMessageId) continue
    const key = child.forkedFromMessageId
    const list = markers[key] ?? []
    list.push({
      type: `forked-to`,
      chatId: child.id,
      chatTitle: child.title,
    })
    markers[key] = list
  }

  if (node.parentId != null && node.forkedFromMessageId != null) {
    const parent = tree.chatsById[node.parentId]
    if (parent) {
      const key = node.forkedFromMessageId
      const list = markers[key] ?? []
      list.push({
        type: `forked-from`,
        chatId: parent.id,
        chatTitle: parent.title,
      })
      markers[key] = list
    }
  }

  return markers
}

export function Chat({
  id,
  initialMessages = [],
  resumeOffset,
  initialForkPoints = {},
}: {
  id: string
  initialMessages?: Array<UIMessage>
  resumeOffset?: string
  initialForkPoints?: Record<string, string>
}) {
  const connection = useMemo(
    () =>
      durableStreamConnection({
        sendUrl: `/api/chat?id=${encodeURIComponent(id)}`,
        readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
        initialOffset: resumeOffset,
        onCustomChunk: forkPointCustomChunkHandler,
      }),
    [id, resumeOffset]
  )

  const [input, setInput] = useState(``)
  const {
    messages: chatMessages,
    sendMessage,
    isLoading,
    sessionGenerating,
    error,
    setMessages,
  } = useChat({
    id,
    initialMessages,
    connection,
    live: true,
  })

  const messages = chatMessages.length > 0 ? chatMessages : initialMessages

  const [forkPoints, setForkPoints] =
    useState<Record<string, string>>(initialForkPoints)

  const [forkMarkers, setForkMarkers] = useState<
    Record<string, Array<ForkMarkerInfo>>
  >(() => computeForkMarkers(loadTree(), id))

  const refreshForkMarkers = useCallback(() => {
    setForkMarkers(computeForkMarkers(loadTree(), id))
  }, [id])

  const refreshForkPoints = useCallback(() => {
    getForkPointsFromServer({ data: id }).then(
      (points) => setForkPoints((prev) => ({ ...prev, ...points })),
      () => {}
    )
  }, [id])

  useEffect(() => {
    if (initialMessages.length > 0 && chatMessages.length === 0) {
      setMessages(initialMessages)
    }
  }, [initialMessages, chatMessages.length, setMessages])

  useEffect(() => {
    const tree = loadTree()
    const updated = setActiveChat(tree, id)
    saveTree(updated)
    window.dispatchEvent(new CustomEvent(`chat-tree-updated`))
  }, [id])

  useEffect(() => {
    const handler = () => refreshForkMarkers()
    window.addEventListener(`chat-tree-updated`, handler)
    return () => window.removeEventListener(`chat-tree-updated`, handler)
  }, [refreshForkMarkers])

  const busy = isLoading
  const showTyping = sessionGenerating || isLoading
  const prevGeneratingRef = useRef(showTyping)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (prevGeneratingRef.current && !showTyping) {
      const tree = loadTree()
      const node = tree.chatsById[id]
      if (
        node &&
        (node.title === `New chat` || node.title === `Restored chat`)
      ) {
        const title = deriveTitleFromMessages(messages as any)
        if (title !== `New chat`) {
          const updated = updateTitle(tree, id, title)
          saveTree(updated)
          window.dispatchEvent(new CustomEvent(`chat-tree-updated`))
        }
      }

      // Fork markers are written shortly after the last message chunk.
      // Give the background writer a moment to flush, then refresh.
      setTimeout(refreshForkPoints, 600)
    }
    prevGeneratingRef.current = showTyping
  }, [showTyping, id, messages, refreshForkPoints])

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: submitted ? `smooth` : `instant`,
    })
  }, [messages, submitted, showTyping])

  useEffect(() => {
    if (!busy) inputRef.current?.focus()
  }, [busy])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || busy) return
    setSubmitted(true)
    sendMessage(input)
    setInput(``)
  }

  return (
    <>
      <ChatHeader chatId={id} />

      <div ref={scrollRef} className="messages-scroll">
        {messages.length === 0 && (
          <div className="messages-empty">
            <div className="messages-empty-icon">💬</div>
            <h2 className="messages-empty-title">Start a conversation</h2>
            <p className="messages-empty-subtitle">
              Send a message to begin. Completed messages can be forked into new
              conversation branches.
            </p>
          </div>
        )}

        <div className="messages-list">
          {messages.map((m) => (
            <div key={m.id}>
              <div
                className={`message-row ${
                  m.role === `user`
                    ? `message-row--user`
                    : `message-row--assistant`
                }`}
              >
                <div className="message-container">
                  <div
                    className={`message-bubble ${
                      m.role === `user`
                        ? `message-bubble--user`
                        : `message-bubble--assistant`
                    }`}
                  >
                    {m.parts
                      .filter((p) => p.type === `text`)
                      .map((p, i) => (
                        <span key={i}>{`content` in p ? p.content : ``}</span>
                      ))}
                  </div>
                  <ForkButton
                    message={m}
                    chatId={id}
                    messages={messages as any}
                    forkPoints={forkPoints}
                  />
                </div>
              </div>
              {m.id in forkMarkers && (
                <ForkPointMarker markers={forkMarkers[m.id]} />
              )}
            </div>
          ))}

          {showTyping &&
            messages[messages.length - 1]?.role !== `assistant` && (
              <div className="typing-indicator">
                <div className="typing-bubble">
                  <span className="typing-dots">
                    <span className="typing-dot">·</span>
                    <span className="typing-dot">·</span>
                    <span className="typing-dot">·</span>
                  </span>
                </div>
              </div>
            )}
        </div>
      </div>

      {error && <div className="chat-error">{error.message}</div>}

      <form onSubmit={handleSubmit} className="composer">
        <div className="composer-inner">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            disabled={busy}
            className="composer-input"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="composer-send"
          >
            Send
          </button>
        </div>
      </form>
    </>
  )
}

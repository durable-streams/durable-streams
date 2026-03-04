"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@tanstack/ai-react"
import { durableStreamConnection } from "@durable-streams/tanstack-ai-transport"
import type { UIMessage } from "@tanstack/ai-react"

export function Chat({
  id,
  initialMessages = [],
  resumeOffset,
}: {
  id: string
  initialMessages?: Array<UIMessage>
  resumeOffset?: string
}) {
  /**
   * Durable session integration:
   * - `postUrl` endpoint (`/api/chat`) accepts a new user prompt and starts model generation.
   * - `readUrl` endpoint (`/api/chat-stream`) resolves the stream from chat id server-side.
   * - `initialOffset` lets this client resume from the SSR snapshot point instead of replaying
   *   the full stream on first subscribe.
   * The connection object is memoized by chat id/offset so `useChat` keeps a stable transport.
   */
  const connection = useMemo(
    () =>
      durableStreamConnection({
        postUrl: `/api/chat?id=${encodeURIComponent(id)}`,
        readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
        initialOffset: resumeOffset,
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
    // `live: true` keeps a read subscription open so all connected clients stay in sync.
    id,
    initialMessages,
    connection,
    live: true,
  })

  // useChat may initially return empty messages on client-side navigation
  // even when initialMessages is provided — fall back to the loader data.
  const messages = chatMessages.length > 0 ? chatMessages : initialMessages

  useEffect(() => {
    if (initialMessages.length > 0 && chatMessages.length === 0) {
      setMessages(initialMessages)
    }
  }, [initialMessages, chatMessages.length, setMessages])
  const busy = isLoading
  const showTyping = sessionGenerating || isLoading
  const prevGeneratingRef = useRef(showTyping)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (prevGeneratingRef.current && !showTyping) {
      window.dispatchEvent(new CustomEvent(`chat-updated`))
    }
    prevGeneratingRef.current = showTyping
  }, [showTyping])

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
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 text-4xl">💬</div>
            <h2 className="mb-1 text-lg font-medium text-gray-700">
              Start a conversation
            </h2>
            <p className="max-w-sm text-sm text-gray-500">
              Send a message to start a streamed AI conversation.
            </p>
          </div>
        )}

        <div className="space-y-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === `user` ? `justify-end` : `justify-start`}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === `user`
                    ? `bg-emerald-600 text-white`
                    : `bg-gray-200 text-gray-900`
                }`}
              >
                {m.parts
                  .filter((p) => p.type === `text`)
                  .map((p, i) => (
                    <span key={i}>{`content` in p ? p.content : ``}</span>
                  ))}
              </div>
            </div>
          ))}

          {showTyping &&
            messages[messages.length - 1]?.role !== `assistant` && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-gray-200 px-4 py-2.5 text-sm text-gray-500">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">·</span>
                    <span className="animate-bounce [animation-delay:0.15s]">
                      ·
                    </span>
                    <span className="animate-bounce [animation-delay:0.3s]">
                      ·
                    </span>
                  </span>
                </div>
              </div>
            )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mb-2 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
          {error.message}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-gray-200 px-6 py-4"
      >
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            disabled={busy}
            className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm outline-none transition-colors placeholder:text-gray-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </>
  )
}

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@tanstack/ai-react"
import { useRouter } from "@tanstack/react-router"
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
  const router = useRouter()

  /**
   * Durable session integration:
   * - `sendUrl` endpoint (`/api/chat`) accepts a new user prompt and starts model generation.
   * - `readUrl` endpoint (`/api/chat-stream`) resolves the stream from chat id server-side.
   * - `initialOffset` lets this client resume from the SSR snapshot point instead of replaying
   *   the full stream on first subscribe.
   * The connection is stable for the component's lifetime: <Chat> is remounted
   * per chat via key={id}.
   */
  const connection = useMemo(
    () =>
      durableStreamConnection({
        sendUrl: `/api/chat?id=${encodeURIComponent(id)}`,
        readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
        initialOffset: resumeOffset,
      }),
    [id, resumeOffset]
  )

  const { messages, sendMessage, isLoading, sessionGenerating, error } =
    useChat({
      // `live: true` keeps a read subscription open so all connected clients stay in sync.
      id,
      initialMessages,
      connection,
      live: true,
      // The chat title is derived server-side from the first user message;
      // re-run route loaders so the sidebar picks it up.
      onFinish: () => router.invalidate(),
    })

  const showTyping =
    (sessionGenerating || isLoading) &&
    messages[messages.length - 1]?.role !== `assistant`

  const [input, setInput] = useState(``)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Keep the newest message in view: jump on first paint, glide afterwards.
  const hasScrolledRef = useRef(false)
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: hasScrolledRef.current ? `smooth` : `instant`,
    })
    hasScrolledRef.current = true
  }, [messages, showTyping])

  useEffect(() => {
    if (!isLoading) inputRef.current?.focus()
  }, [isLoading])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || isLoading) return
    sendMessage(text)
    setInput(``)
  }

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 && <EmptyState />}

        <div className="space-y-4">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {showTyping && <TypingIndicator />}
        </div>
      </div>

      {error && (
        <div className="mx-6 mb-2 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
          {error.message}
        </div>
      )}

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
            disabled={isLoading}
            className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm outline-none transition-colors placeholder:text-gray-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-3 text-4xl">💬</div>
      <h2 className="mb-1 text-lg font-medium text-gray-700">
        Start a conversation
      </h2>
      <p className="max-w-sm text-sm text-gray-500">
        Send a message to start a streamed AI conversation.
      </p>
    </div>
  )
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === `user`
  const text = message.parts
    .filter((part) => part.type === `text`)
    .map((part) => (`content` in part ? part.content : ``))
    .join(``)

  return (
    <div className={`flex ${isUser ? `justify-end` : `justify-start`}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser ? `bg-emerald-600 text-white` : `bg-gray-200 text-gray-900`
        }`}
      >
        {text}
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl bg-gray-200 px-4 py-2.5 text-sm text-gray-500">
        <span className="inline-flex gap-1">
          <span className="animate-bounce">·</span>
          <span className="animate-bounce [animation-delay:0.15s]">·</span>
          <span className="animate-bounce [animation-delay:0.3s]">·</span>
        </span>
      </div>
    </div>
  )
}

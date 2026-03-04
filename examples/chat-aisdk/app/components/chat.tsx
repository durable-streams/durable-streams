"use client"

import { useChat } from "@ai-sdk/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { DefaultChatTransport } from "ai"
import type { UIMessage } from "ai"

export function Chat({
  id,
  initialMessages = [],
}: {
  id: string
  initialMessages?: Array<UIMessage>
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/chat`,
      }),
    []
  )

  const { messages, sendMessage, status, error, setMessages } = useChat({
    id,
    messages: initialMessages,
    transport,
  })

  // useChat can briefly report empty messages after navigation/reload.
  // Keep server-provided history visible and sync it back into the chat state.
  const displayedMessages = messages.length > 0 ? messages : initialMessages

  const busy = status === `submitted` || status === `streaming`
  const prevBusyRef = useRef(busy)
  const [input, setInput] = useState(``)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    // During hydration/resume, useChat can momentarily be empty.
    // Re-seed from server data so the UI never flashes blank.
    if (initialMessages.length > 0 && messages.length === 0) {
      setMessages(initialMessages)
    }
  }, [initialMessages, messages.length, setMessages])

  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      window.dispatchEvent(new CustomEvent(`chat-updated`))
    }
    prevBusyRef.current = busy
  }, [busy])

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: submitted ? `smooth` : `instant`,
    })
  }, [displayedMessages, submitted])

  useEffect(() => {
    if (!busy) inputRef.current?.focus()
  }, [busy])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || busy) return
    setSubmitted(true)
    sendMessage({ text: input })
    setInput(``)
  }

  return (
    <>
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {displayedMessages.length === 0 && (
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
          {displayedMessages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === `user` ? `justify-end` : `justify-start`}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === `user`
                    ? `bg-blue-600 text-white`
                    : `bg-gray-200 text-gray-900`
                }`}
              >
                {m.parts
                  .filter((p) => p.type === `text`)
                  .map((p, i) => (
                    <span key={i}>{`text` in p ? p.text : ``}</span>
                  ))}
              </div>
            </div>
          ))}

          {busy &&
            displayedMessages[displayedMessages.length - 1]?.role !==
              `assistant` && (
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
            className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </>
  )
}

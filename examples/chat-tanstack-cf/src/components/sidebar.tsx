"use client"

import { Link, useLocation } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import type { ChatSummary } from "~/lib/chat-types"

export function Sidebar({
  initialChats,
}: {
  initialChats: Array<ChatSummary>
}) {
  const location = useLocation()
  const activeChatId = location.pathname.startsWith(`/chat/`)
    ? location.pathname.split(`/`)[2]
    : undefined

  const [chats, setChats] = useState(initialChats)

  const refreshChats = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats`)
      if (res.ok) setChats(await res.json())
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    refreshChats()
  }, [location.pathname, refreshChats])

  useEffect(() => {
    const handler = () => refreshChats()
    window.addEventListener(`chat-updated`, handler)
    return () => window.removeEventListener(`chat-updated`, handler)
  }, [refreshChats])

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
      <div className="flex items-center justify-between px-4 py-4">
        <h2 className="text-sm font-semibold text-gray-600">Chats</h2>
        <Link
          to="/chat"
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700"
        >
          New
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        {chats.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-gray-400">
            No conversations yet
          </p>
        )}
        <ul className="space-y-0.5">
          {chats.map((chat) => (
            <li key={chat.id}>
              <Link
                to="/chat/$id"
                params={{ id: chat.id }}
                preload={false}
                className={`block truncate rounded-lg px-3 py-2 text-sm transition-colors ${
                  chat.id === activeChatId
                    ? `bg-emerald-100 font-medium text-emerald-900`
                    : `text-gray-700 hover:bg-gray-100`
                }`}
              >
                {chat.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-gray-200 px-4 py-3">
        <p className="text-[10px] leading-tight text-gray-400">
          Streams via Durable Streams Proxy
        </p>
      </div>
    </aside>
  )
}

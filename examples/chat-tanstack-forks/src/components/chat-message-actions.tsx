"use client"

import { Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useState } from "react"
import type { ChatNode } from "~/lib/chat-tree"
import {
  deriveTitleFromMessages,
  insertForkChild,
  loadTree,
  saveTree,
} from "~/lib/chat-tree"
import { getForkOffset } from "~/lib/fork-points"
import { buildChatStreamPath } from "~/lib/durable-streams-config"

export interface ForkMarkerInfo {
  type: `forked-to` | `forked-from`
  chatId: string
  chatTitle: string
}

export function ForkPointMarker({
  markers,
}: {
  markers: Array<ForkMarkerInfo>
}) {
  if (markers.length === 0) return null
  return (
    <div className="fork-point-markers">
      {markers.map((m) => (
        <Link
          key={`${m.type}-${m.chatId}`}
          to="/chat/$id"
          params={{ id: m.chatId }}
          preload={false}
          className={`fork-point-marker fork-point-marker--${m.type}`}
        >
          <span className="fork-point-marker-icon">
            {m.type === `forked-to` ? `↳` : `↰`}
          </span>
          <span className="fork-point-marker-label">
            {m.type === `forked-to` ? `Forked to` : `Forked from`}
          </span>
          <span className="fork-point-marker-title">{m.chatTitle}</span>
        </Link>
      ))}
    </div>
  )
}

export function ForkButton({
  message,
  chatId,
  messages,
  forkPoints,
}: {
  message: any
  chatId: string
  messages: Array<any>
  forkPoints?: Record<string, string>
}) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const forkOffset = getForkOffset(message) ?? forkPoints?.[message.id]

  const handleFork = useCallback(async () => {
    if (!forkOffset || pending) return
    setPending(true)
    setError(null)

    try {
      const res = await fetch(`/api/chat-forks`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({
          sourceChatId: chatId,
          sourceMessageId: message.id,
          forkOffset,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Fork failed`)
      }

      const { chat: childData } = await res.json()

      const tree = loadTree()
      const parentNode = tree.chatsById[chatId]
      const parentDepth = parentNode?.depth ?? 0

      const messageIndex = messages.findIndex((m) => m.id === message.id)
      const inheritedMessages =
        messageIndex >= 0 ? messages.slice(0, messageIndex + 1) : messages
      const baseTitle =
        deriveTitleFromMessages(inheritedMessages) !== `New chat`
          ? deriveTitleFromMessages(inheritedMessages)
          : `Fork of ${parentNode?.title ?? `Chat`}`

      const allTitles = new Set(
        Object.values(tree.chatsById)
          .map((node) => node?.title)
          .filter(Boolean)
      )
      let childTitle = baseTitle
      let n = 2
      while (allTitles.has(childTitle)) {
        childTitle = `${baseTitle} ${n}`
        n++
      }

      const childNode: ChatNode = {
        id: childData.id,
        title: childTitle,
        createdAt: childData.createdAt,
        updatedAt: childData.createdAt,
        parentId: chatId,
        childIds: [],
        forkedFromMessageId: message.id,
        forkOffset,
        sourceStreamPath: buildChatStreamPath(childData.id),
        depth: parentDepth + 1,
      }

      const newTree = insertForkChild(tree, childNode)
      saveTree(newTree)
      window.dispatchEvent(new CustomEvent(`chat-tree-updated`))

      navigate({ to: `/chat/$id`, params: { id: childData.id } })
    } catch (err: any) {
      setError(err.message)
      setPending(false)
    }
  }, [chatId, message.id, forkOffset, pending, messages, navigate])

  if (!forkOffset) return null

  return (
    <div className="message-actions">
      <button onClick={handleFork} disabled={pending} className="fork-btn">
        {pending ? `Forking…` : `Fork chat`}
      </button>
      {error && (
        <span style={{ fontSize: `11px`, color: `var(--color-error-text)` }}>
          {error}
        </span>
      )}
    </div>
  )
}

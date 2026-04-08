"use client"

import { loadTree } from "~/lib/chat-tree"

export function ChatHeader({ chatId }: { chatId: string }) {
  const tree = loadTree()
  const node = tree.chatsById[chatId]
  const isRoot = !node?.parentId
  const parentNode =
    node?.parentId != null ? tree.chatsById[node.parentId] : null

  return (
    <header className="chat-header">
      <h1 className="chat-header-title">{node?.title ?? `Chat`}</h1>
      <span
        className={`chat-header-badge ${isRoot ? `chat-header-badge--root` : `chat-header-badge--fork`}`}
      >
        {isRoot ? `Root` : `Fork`}
      </span>
      {parentNode && (
        <span className="chat-header-ancestry">
          Forked from &ldquo;{parentNode.title}&rdquo;
        </span>
      )}
    </header>
  )
}

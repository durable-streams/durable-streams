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
      <button
        className="sidebar-toggle"
        onClick={() => window.dispatchEvent(new CustomEvent(`toggle-sidebar`))}
        aria-label="Toggle sidebar"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path
            d="M3 5h14M3 10h14M3 15h14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
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

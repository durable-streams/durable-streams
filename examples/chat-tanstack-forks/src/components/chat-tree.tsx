"use client"

import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import type { ChatNode, ChatTreeState } from "~/lib/chat-tree"
import {
  createRootNode,
  getRootNodes,
  insertRootChat,
  loadTree,
  saveTree,
  setActiveChat,
} from "~/lib/chat-tree"

export function ChatTreeSidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const [tree, setTree] = useState<ChatTreeState>(loadTree)

  const activeChatId = location.pathname.startsWith(`/chat/`)
    ? location.pathname.split(`/`)[2]
    : undefined

  useEffect(() => {
    setTree(loadTree())
  }, [location.pathname])

  useEffect(() => {
    const handler = () => setTree(loadTree())
    window.addEventListener(`chat-tree-updated`, handler)
    window.addEventListener(`storage`, handler)
    return () => {
      window.removeEventListener(`chat-tree-updated`, handler)
      window.removeEventListener(`storage`, handler)
    }
  }, [])

  const handleNewChat = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats/root`, { method: `POST` })
      if (!res.ok) return
      const data = await res.json()
      const currentTree = loadTree()
      const node = createRootNode(data.id, data.streamPath)
      const newTree = insertRootChat(currentTree, node)
      saveTree(newTree)
      setTree(newTree)
      navigate({ to: `/chat/$id`, params: { id: data.id } })
    } catch {
      // ignore
    }
  }, [navigate])

  const rootNodes = getRootNodes(tree)

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Chats</span>
        <button onClick={handleNewChat} className="sidebar-new-btn">
          New
        </button>
      </div>

      <nav className="sidebar-tree">
        {rootNodes.length === 0 && (
          <p
            style={{
              padding: `16px 8px`,
              textAlign: `center`,
              fontSize: `12px`,
              color: `var(--color-text-muted)`,
            }}
          >
            No conversations yet
          </p>
        )}
        {rootNodes.map((node, i) => (
          <TreeNodeItem
            key={node.id}
            node={node}
            tree={tree}
            activeChatId={activeChatId}
            isLast={i === rootNodes.length - 1}
            depth={0}
            onNavigate={(chatId) => {
              const updated = setActiveChat(loadTree(), chatId)
              saveTree(updated)
              setTree(updated)
            }}
          />
        ))}
      </nav>

      <div className="sidebar-footer">
        <p className="sidebar-footer-text">
          Messages durable via Durable Streams
          <br />
          Tree stored in localStorage
        </p>
      </div>
    </aside>
  )
}

function TreeNodeItem({
  node,
  tree,
  activeChatId,
  onNavigate,
  isLast = false,
  depth = 0,
}: {
  node: ChatNode
  tree: ChatTreeState
  activeChatId: string | undefined
  onNavigate: (chatId: string) => void
  isLast?: boolean
  depth?: number
}) {
  const isActive = node.id === activeChatId
  const children = node.childIds
    .map((id) => tree.chatsById[id])
    .filter(Boolean) as Array<ChatNode>
  const isRoot = depth === 0

  return (
    <div
      className={`tree-item ${!isRoot ? (isLast ? `tree-item--last` : `tree-item--mid`) : ``}`}
    >
      {!isRoot && <span className="tree-line-connector" />}
      <div className="tree-item-content">
        <Link
          to="/chat/$id"
          params={{ id: node.id }}
          preload={false}
          onClick={() => onNavigate(node.id)}
          className={`tree-node ${isActive ? `tree-node--active` : ``}`}
        >
          <span className="tree-node-title">{node.title}</span>
          {node.parentId && <span className="tree-node-badge">Fork</span>}
        </Link>
        {children.length > 0 && (
          <div className="tree-children">
            {children.map((child, i) => (
              <TreeNodeItem
                key={child.id}
                node={child}
                tree={tree}
                activeChatId={activeChatId}
                onNavigate={onNavigate}
                isLast={i === children.length - 1}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

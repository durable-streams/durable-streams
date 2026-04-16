"use client"

import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
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
  const [aboutOpen, setAboutOpen] = useState(() => {
    if (typeof window === `undefined`) return false
    return !localStorage.getItem(`about-dismissed`)
  })

  const [sidebarOpen, setSidebarOpen] = useState(false)

  const activeChatId = location.pathname.startsWith(`/chat/`)
    ? location.pathname.split(`/`)[2]
    : undefined

  useEffect(() => {
    setTree(loadTree())
    setSidebarOpen(false)
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

  useEffect(() => {
    const handler = () => setSidebarOpen((prev) => !prev)
    window.addEventListener(`toggle-sidebar`, handler)
    return () => window.removeEventListener(`toggle-sidebar`, handler)
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
    <>
      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? `sidebar--open` : ``}`}>
        <div className="sidebar-header">
          <span className="sidebar-title">Chats</span>
          <div className="sidebar-header-actions">
            <button
              onClick={() => setAboutOpen(true)}
              className="sidebar-about-btn"
              title="About this demo"
            >
              ?
            </button>
            <button onClick={handleNewChat} className="sidebar-new-btn">
              New
            </button>
          </div>
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
          <span className="sidebar-footer-text">
            Built with{` `}
            <a
              href="https://durablestreams.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Durable Streams
            </a>
            {` `}&{` `}
            <a
              href="https://tanstack.com/ai/latest"
              target="_blank"
              rel="noopener noreferrer"
            >
              TanStack AI
            </a>
          </span>
        </div>

        <AboutModal
          open={aboutOpen}
          onClose={() => {
            setAboutOpen(false)
            localStorage.setItem(`about-dismissed`, `1`)
          }}
        />
      </aside>
    </>
  )
}

function AboutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const handler = () => onClose()
    el.addEventListener(`close`, handler)
    return () => el.removeEventListener(`close`, handler)
  }, [onClose])

  return (
    <dialog ref={dialogRef} className="about-modal" onClick={onClose}>
      <div className="about-modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="about-modal-title">Durable Chat — Fork Demo</h2>
        <p>
          A chat application demonstrating{` `}
          <a
            href="https://durablestreams.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            Durable Streams
          </a>
          {` `}
          with{` `}
          <a
            href="https://tanstack.com/ai/latest"
            target="_blank"
            rel="noopener noreferrer"
          >
            TanStack&nbsp;AI
          </a>
          .
        </p>
        <p>
          Every message is persisted to a durable stream, so conversations
          survive page refreshes and can be shared across clients in
          real&nbsp;time.
        </p>
        <p>
          The <strong>fork</strong> feature lets you branch any conversation at
          a specific message. This is enabled by durable streams being natively
          forkable — a forked stream references its parent at a given offset, so
          no data is copied. Forking is instant regardless of
          conversation&nbsp;length.
        </p>
        <p className="about-modal-made-by">
          Durable Streams is made by the team behind{` `}
          <a
            href="https://electric-sql.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            ElectricSQL
          </a>
          ,{` `}
          <a
            href="https://pglite.dev"
            target="_blank"
            rel="noopener noreferrer"
          >
            PGlite
          </a>
          {` `}&{` `}
          <a
            href="https://tanstack.com/db/latest"
            target="_blank"
            rel="noopener noreferrer"
          >
            TanStack&nbsp;DB
          </a>
          .
        </p>
        <div className="about-modal-actions">
          <button onClick={onClose} className="about-modal-close">
            Close
          </button>
        </div>
      </div>
    </dialog>
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

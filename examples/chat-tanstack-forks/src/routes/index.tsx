"use client"

import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import {
  createRootNode,
  insertRootChat,
  loadTree,
  saveTree,
} from "~/lib/chat-tree"

export const Route = createFileRoute(`/`)({
  component: BootstrapPage,
})

function BootstrapPage() {
  const navigate = useNavigate()

  useEffect(() => {
    async function bootstrap() {
      const tree = loadTree()

      if (tree.activeChatId && tree.chatsById[tree.activeChatId]) {
        navigate({ to: `/chat/$id`, params: { id: tree.activeChatId } })
        return
      }

      try {
        const res = await fetch(`/api/chats/root`, { method: `POST` })
        if (!res.ok) throw new Error(`Failed to create root chat`)
        const data = await res.json()
        const node = createRootNode(data.id, data.streamPath)
        const newTree = insertRootChat(tree, node)
        saveTree(newTree)
        navigate({ to: `/chat/$id`, params: { id: data.id } })
      } catch (err) {
        console.error(`Bootstrap failed`, err)
      }
    }

    bootstrap()
  }, [navigate])

  return <div className="bootstrap-loading">Loading…</div>
}

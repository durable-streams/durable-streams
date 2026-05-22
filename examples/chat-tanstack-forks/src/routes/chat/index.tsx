"use client"

import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import {
  createRootNode,
  insertRootChat,
  loadTree,
  saveTree,
} from "~/lib/chat-tree"

export const Route = createFileRoute(`/chat/`)({
  component: ChatIndexPage,
})

function ChatIndexPage() {
  const navigate = useNavigate()

  useEffect(() => {
    async function createChat() {
      try {
        const res = await fetch(`/api/chats/root`, { method: `POST` })
        if (!res.ok) throw new Error(`Failed to create chat`)
        const data = await res.json()
        const tree = loadTree()
        const node = createRootNode(data.id, data.streamPath)
        const newTree = insertRootChat(tree, node)
        saveTree(newTree)
        navigate({ to: `/chat/$id`, params: { id: data.id } })
      } catch (err) {
        console.error(`Failed to create new chat`, err)
      }
    }

    createChat()
  }, [navigate])

  return <div className="bootstrap-loading">Creating new chat…</div>
}

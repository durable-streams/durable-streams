import { useEffect, useState } from "react"
import { deleteConversation, getAllConversations } from "../lib/storage"
import { TrashIcon } from "./icons/TrashIcon"
import "../styles/sidebar.css"

interface SidebarProps {
  currentConversationId: string
  proxyUrl: string
  onSelectConversation: (id: string) => void
  onNewConversation: () => void
  currentConversationHasMessages?: boolean
}

export function Sidebar({
  currentConversationId,
  proxyUrl,
  onSelectConversation,
  onNewConversation,
  currentConversationHasMessages,
}: SidebarProps) {
  const [conversations, setConversations] = useState<Array<string>>([])
  const [deleting, setDeleting] = useState<string | null>(null)

  // Track which conversations have actual data (vs placeholder for current)
  const [savedConversations, setSavedConversations] = useState<Set<string>>(
    new Set()
  )

  // Load conversations and ensure current conversation is included
  useEffect(() => {
    const allConversations = getAllConversations()
    setSavedConversations(new Set(allConversations))
    // Always include current conversation, even if it has no messages yet
    if (
      currentConversationId &&
      !allConversations.includes(currentConversationId)
    ) {
      allConversations.unshift(currentConversationId)
    }
    setConversations(allConversations)
  }, [currentConversationId])

  // Update savedConversations when current conversation gets messages
  useEffect(() => {
    if (currentConversationHasMessages && currentConversationId) {
      setSavedConversations((prev) => {
        if (prev.has(currentConversationId)) return prev
        return new Set([...prev, currentConversationId])
      })
    }
  }, [currentConversationHasMessages, currentConversationId])

  const handleDelete = async (e: React.MouseEvent, convId: string) => {
    e.stopPropagation()
    if (deleting) return

    setDeleting(convId)
    await deleteConversation(convId, proxyUrl)
    const allConversations = getAllConversations()
    if (
      currentConversationId &&
      !allConversations.includes(currentConversationId)
    ) {
      allConversations.unshift(currentConversationId)
    }
    setConversations(allConversations)
    setDeleting(null)

    if (convId === currentConversationId) {
      onNewConversation()
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button onClick={onNewConversation} className="sidebar-new-button">
          + New Chat
        </button>
      </div>
      <div className="sidebar-content">
        {conversations.map((convId) => (
          <div
            key={convId}
            onClick={() => onSelectConversation(convId)}
            className={`sidebar-conversation ${convId === currentConversationId ? `sidebar-conversation--selected` : ``}`}
          >
            <span className="sidebar-conversation-text">
              {convId.replace(`conv-`, ``)}
            </span>
            {savedConversations.has(convId) && (
              <button
                onClick={(e) => handleDelete(e, convId)}
                disabled={deleting === convId}
                className="sidebar-delete-button"
                title="Delete conversation"
              >
                {deleting === convId ? `...` : <TrashIcon />}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

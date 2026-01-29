import { useNavigate } from "@tanstack/react-router"
import { createConversation, deleteConversation } from "./storage"
import type { Conversation } from "./storage"

interface SidebarProps {
  conversations: Array<Conversation>
  activeId: string | undefined
  open: boolean
  onConversationsChange: () => void
}

export function Sidebar({
  conversations,
  activeId,
  open,
  onConversationsChange,
}: SidebarProps) {
  const navigate = useNavigate()

  const handleNew = () => {
    const conversation = createConversation()
    onConversationsChange()
    navigate({ to: `/chat/$id`, params: { id: conversation.id } })
  }

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    deleteConversation(id)
    onConversationsChange()
    if (id === activeId) {
      navigate({ to: `/` })
    }
  }

  return (
    <aside className={`sidebar ${open ? `open` : `closed`}`}>
      <div className="sidebar-header">
        <span className="sidebar-title">Conversations</span>
        <button className="new-chat-btn" onClick={handleNew}>
          + New
        </button>
      </div>
      <div className="sidebar-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`sidebar-item ${conv.id === activeId ? `active` : ``}`}
            onClick={() =>
              navigate({ to: `/chat/$id`, params: { id: conv.id } })
            }
          >
            <span className="sidebar-item-title">{conv.title}</span>
            <button
              className="delete-btn"
              onClick={(e) => handleDelete(e, conv.id)}
              aria-label="Delete conversation"
            >
              &times;
            </button>
          </div>
        ))}
        {conversations.length === 0 && (
          <div className="sidebar-empty">No conversations yet</div>
        )}
      </div>
    </aside>
  )
}

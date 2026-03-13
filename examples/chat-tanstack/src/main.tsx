import { StrictMode, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import { Chat } from "./Chat"
import { Sidebar } from "./Sidebar"
import { createConversation, getConversations } from "./storage"
import "./styles.css"

// Simple pub/sub so Chat can notify the root layout when conversations change
let listeners: Array<() => void> = []
let conversationsSnapshot = getConversations()

function subscribe(listener: () => void) {
  listeners = [...listeners, listener]
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function getSnapshot() {
  return conversationsSnapshot
}

export function notifyConversationsChanged() {
  conversationsSnapshot = getConversations()
  for (const listener of listeners) {
    listener()
  }
}

// Sidebar state shared between root layout and child pages
let sidebarOpen = true
let sidebarListeners: Array<() => void> = []

function subscribeSidebar(listener: () => void) {
  sidebarListeners = [...sidebarListeners, listener]
  return () => {
    sidebarListeners = sidebarListeners.filter((l) => l !== listener)
  }
}

function getSidebarSnapshot() {
  return sidebarOpen
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen
  for (const listener of sidebarListeners) {
    listener()
  }
}

function RootLayout() {
  const conversations = useSyncExternalStore(subscribe, getSnapshot)
  const isSidebarOpen = useSyncExternalStore(
    subscribeSidebar,
    getSidebarSnapshot
  )

  // Extract active conversation ID from router state
  const location = useRouterState({ select: (s) => s.location })
  const match = location.pathname.match(/^\/chat\/(.+)$/)
  const activeId = match ? match[1] : undefined

  return (
    <div className="app-layout">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={isSidebarOpen}
        onConversationsChange={notifyConversationsChanged}
      />
      <Outlet />
    </div>
  )
}

function WelcomePage() {
  const navigate = useNavigate()
  const isSidebarOpen = useSyncExternalStore(
    subscribeSidebar,
    getSidebarSnapshot
  )

  const handleNewChat = () => {
    const conversation = createConversation()
    notifyConversationsChanged()
    navigate({ to: `/chat/$id`, params: { id: conversation.id } })
  }

  return (
    <div className="chat-container">
      <header className="chat-header">
        <button className="sidebar-toggle" onClick={toggleSidebar}>
          {isSidebarOpen ? `\u2190` : `\u2192`}
        </button>
        <span>Chat</span>
      </header>
      <main className="chat-messages">
        <div className="empty-state">
          <button className="new-chat-btn primary" onClick={handleNewChat}>
            Start a new conversation
          </button>
        </div>
      </main>
    </div>
  )
}

function ChatPage() {
  const { id } = chatRoute.useParams()
  const navigate = useNavigate()
  const conversations = useSyncExternalStore(subscribe, getSnapshot)
  const isSidebarOpen = useSyncExternalStore(
    subscribeSidebar,
    getSidebarSnapshot
  )

  if (!conversations.some((c) => c.id === id)) {
    navigate({ to: `/` })
    return null
  }

  return (
    <Chat
      key={id}
      conversationId={id}
      sidebarOpen={isSidebarOpen}
      onToggleSidebar={toggleSidebar}
      onMessagesChange={notifyConversationsChanged}
    />
  )
}

const rootRoute = createRootRoute({
  component: RootLayout,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: `/`,
  component: WelcomePage,
})

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: `/chat/$id`,
  component: ChatPage,
})

const routeTree = rootRoute.addChildren([indexRoute, chatRoute])

const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById(`root`)!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)

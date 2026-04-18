import { Outlet, createFileRoute } from "@tanstack/react-router"
import { ChatTreeSidebar } from "~/components/chat-tree"

export const Route = createFileRoute(`/chat`)({
  component: ChatLayout,
})

function ChatLayout() {
  return (
    <div className="app-layout">
      <ChatTreeSidebar />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}

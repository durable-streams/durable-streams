import { Outlet, createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { Sidebar } from "~/components/sidebar"

const getChats = createServerFn().handler(async () => {
  const { listChats } = await import(`~/lib/chat-store`)
  return listChats()
})

export const Route = createFileRoute(`/chat`)({
  loader: () => getChats(),
  component: ChatLayout,
})

function ChatLayout() {
  const chats = Route.useLoaderData()

  return (
    <div className="flex h-dvh">
      <Sidebar initialChats={chats} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-gray-200 px-6 py-4">
          <h1 className="text-lg font-semibold">Durable Chat</h1>
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
            TanStack Start + TanStack AI
          </span>
        </header>
        <Outlet />
      </main>
    </div>
  )
}

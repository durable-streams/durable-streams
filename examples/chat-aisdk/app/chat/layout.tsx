import { listChats } from "../lib/chat-store"
import { Sidebar } from "../components/sidebar"

export const dynamic = `force-dynamic`

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const chats = await listChats()

  return (
    <div className="flex h-dvh">
      <Sidebar initialChats={chats} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-gray-200 px-6 py-4">
          <h1 className="text-lg font-semibold">Chat</h1>
          <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
            Next.js + Vercel AI SDK
          </span>
        </header>
        {children}
      </main>
    </div>
  )
}

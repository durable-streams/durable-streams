import { Outlet, createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { startTransition, useEffect, useState } from "react"
import type { SessionSummary } from "~/lib/session-types"
import { SessionSidebar } from "~/components/session-sidebar"
import { DEFAULT_AGENT_CWD } from "~/lib/config"
import { SessionsProvider } from "~/lib/sessions-context"
import { listSessionSummaries } from "~/lib/session-manager"

const getLayoutData = createServerFn().handler(async () => ({
  sessions: await listSessionSummaries(),
  defaultCwd: DEFAULT_AGENT_CWD,
}))

export const Route = createFileRoute(`/session`)({
  loader: () => getLayoutData(),
  component: SessionLayout,
  staleTime: 0,
})

function SessionLayout() {
  const loaderData = Route.useLoaderData()
  const [sessions, setSessions] = useState<Array<SessionSummary>>(
    loaderData.sessions
  )

  const refresh = async () => {
    const response = await fetch(`/api/sessions`)
    if (!response.ok) {
      return
    }

    const nextSessions = (await response.json()) as Array<SessionSummary>
    startTransition(() => {
      setSessions(nextSessions)
    })
  }

  const replaceSession = (nextSession: SessionSummary) => {
    setSessions((current) => {
      const withoutCurrent = current.filter(
        (session) => session.id !== nextSession.id
      )
      return [nextSession, ...withoutCurrent].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
      )
    })
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh()
    }, 5000)

    return () => window.clearInterval(interval)
  }, [])

  return (
    <SessionsProvider value={{ sessions, refresh, replaceSession }}>
      <div className="app-shell">
        <SessionSidebar defaultCwd={loaderData.defaultCwd} />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </SessionsProvider>
  )
}

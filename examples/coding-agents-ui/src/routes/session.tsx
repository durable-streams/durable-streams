import { Outlet, createFileRoute } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { createServerFn } from "@tanstack/react-start"
import { useEffect, useState } from "react"
import type { SessionSummary } from "~/lib/session-types"
import { SessionSidebar } from "~/components/session-sidebar"
import { DEFAULT_AGENT_CWD } from "~/lib/config"
import { SessionsProvider } from "~/lib/sessions-context"
import { listSessionSummaries } from "~/lib/session-manager"
import {
  createSessionAction,
  createSessionControlAction,
  createSessionsCollection,
  reconcileSessionSummaries,
  upsertSessionSummary,
} from "~/lib/sessions-db"

const getLayoutData = createServerFn().handler(async () => ({
  sessions: await listSessionSummaries(),
  defaultCwd: DEFAULT_AGENT_CWD,
}))

export const Route = createFileRoute(`/session`)({
  ssr: false,
  loader: () => getLayoutData(),
  component: SessionLayout,
  staleTime: 0,
})

function SessionLayout() {
  const loaderData = Route.useLoaderData()
  const [sessionsCollection] = useState(() =>
    createSessionsCollection(loaderData.sessions)
  )
  const [createSession] = useState(() =>
    createSessionAction(sessionsCollection)
  )
  const [controlSessionAction] = useState(() =>
    createSessionControlAction(sessionsCollection)
  )
  const { data: sessions = [] } = useLiveQuery(
    (q) =>
      q
        .from({ session: sessionsCollection })
        .orderBy(({ session }) => session.updatedAt, `desc`),
    [sessionsCollection]
  )

  const refresh = async () => {
    const response = await fetch(`/api/sessions`)
    if (!response.ok) {
      return
    }

    const nextSessions = (await response.json()) as Array<SessionSummary>
    reconcileSessionSummaries(sessionsCollection, nextSessions)
  }

  const replaceSession = (nextSession: SessionSummary) => {
    upsertSessionSummary(sessionsCollection, nextSession, { optimistic: false })
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh()
    }, 5000)

    return () => window.clearInterval(interval)
  }, [])

  return (
    <SessionsProvider
      value={{
        sessions,
        refresh,
        replaceSession,
        createSession,
        controlSession: (session, action) =>
          controlSessionAction({ session, action }),
      }}
    >
      <div className="app-shell">
        <SessionSidebar defaultCwd={loaderData.defaultCwd} />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </SessionsProvider>
  )
}

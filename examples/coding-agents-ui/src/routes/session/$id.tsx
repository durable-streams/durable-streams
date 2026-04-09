import { createFileRoute } from "@tanstack/react-router"
import { SessionView } from "~/components/session-view"
import { useSessions } from "~/lib/sessions-context"

export const Route = createFileRoute(`/session/$id`)({
  ssr: false,
  component: SessionPage,
  staleTime: 0,
})

function SessionPage() {
  const { id } = Route.useParams()
  const { sessions } = useSessions()
  const session = sessions.find((entry) => entry.id === id)

  if (!session) {
    return (
      <section className="session-stage empty-stage">
        <p className="eyebrow">Session</p>
        <h2>Session unavailable</h2>
        <p className="stage-copy">
          The session does not exist locally. If you just started it, the
          optimistic row may have rolled back because the server rejected the
          request.
        </p>
      </section>
    )
  }

  return <SessionView key={session.id} initialSession={session} />
}

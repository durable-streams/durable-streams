import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { SessionView } from "~/components/session-view"
import { getSessionSummary } from "~/lib/session-manager"

const getSessionData = createServerFn({ method: `GET` })
  .inputValidator((id: string) => id)
  .handler(async ({ data }) => getSessionSummary(data))

export const Route = createFileRoute(`/session/$id`)({
  loader: async ({ params }) => {
    const session = await getSessionData({ data: params.id })
    if (!session) {
      throw redirect({ to: `/session` })
    }
    return session
  },
  component: SessionPage,
  staleTime: 0,
})

function SessionPage() {
  const session = Route.useLoaderData()
  return <SessionView key={session.id} initialSession={session} />
}

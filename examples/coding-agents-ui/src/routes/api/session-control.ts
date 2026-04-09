import { createFileRoute } from "@tanstack/react-router"
import type { SessionControlPayload } from "~/lib/session-types"
import { buildClientStreamUrl } from "~/lib/client-stream-url"
import {
  getSessionRecord,
  toSessionSummary,
  touchSessionRecord,
} from "~/lib/session-store"
import {
  isSessionActive,
  startManagedSession,
  stopManagedSession,
} from "~/lib/session-manager"

export const Route = createFileRoute(`/api/session-control`)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = (await request.json()) as SessionControlPayload
        const record = await getSessionRecord(payload.id)
        if (!record) {
          return new Response(`unknown session`, { status: 404 })
        }

        if (payload.action === `stop`) {
          await stopManagedSession(record.id)
        } else {
          await startManagedSession(record, `resume`)
        }

        await touchSessionRecord(record.id)

        return Response.json(
          toSessionSummary(
            { ...record, updatedAt: new Date().toISOString() },
            isSessionActive(record.id),
            buildClientStreamUrl(record.id)
          )
        )
      },
    },
  },
})

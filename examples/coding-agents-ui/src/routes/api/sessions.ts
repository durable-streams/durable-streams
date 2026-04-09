import { createFileRoute } from "@tanstack/react-router"
import type { CreateSessionPayload } from "~/lib/session-types"
import { buildClientStreamUrl } from "~/lib/client-stream-url"
import {
  buildSessionRecord,
  getSessionRecord,
  saveSessionRecord,
  toSessionSummary,
} from "~/lib/session-store"
import {
  isSessionActive,
  listSessionSummaries,
  startManagedSession,
} from "~/lib/session-manager"

export const Route = createFileRoute(`/api/sessions`)({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(await listSessionSummaries())
      },

      POST: async ({ request }) => {
        const payload = (await request.json()) as CreateSessionPayload
        if (!payload.cwd.trim()) {
          return new Response(`cwd is required`, { status: 400 })
        }

        const record = buildSessionRecord(payload)
        if (await getSessionRecord(record.id)) {
          return new Response(`session already exists`, { status: 409 })
        }

        await startManagedSession(record, `start`)
        await saveSessionRecord(record)

        return Response.json(
          toSessionSummary(
            record,
            isSessionActive(record.id),
            buildClientStreamUrl(record.id)
          ),
          { status: 201 }
        )
      },
    },
  },
})

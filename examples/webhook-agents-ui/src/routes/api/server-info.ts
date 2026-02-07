/**
 * GET /api/server-info — returns DS server URL and current tasks.
 * POST /api/server-info — creates a task or sends a follow-up.
 */

import { createFileRoute } from "@tanstack/react-router"
import {
  addFollowUp,
  createTask,
  getServerUrl,
  getTasks,
} from "../../server/functions"

/** Extract our own origin from the incoming request. */
function selfOrigin(request: Request): string {
  const url = new URL(request.url)
  return url.origin
}

export const Route = createFileRoute(`/api/server-info`)({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = selfOrigin(request)
        const serverUrl = await getServerUrl(origin)
        const tasks = await getTasks(origin)
        return Response.json({ serverUrl, tasks })
      },
      POST: async ({ request }) => {
        const origin = selfOrigin(request)
        const body = (await request.json()) as {
          action: `create` | `followup`
          description: string
          path?: string
        }

        if (body.action === `create`) {
          const result = await createTask(origin, body.description)
          return Response.json(result)
        }

        if (!body.path) {
          return new Response(`Bad request`, { status: 400 })
        }

        await addFollowUp(origin, body.path, body.description)
        return Response.json({ ok: true })
      },
    },
  },
})

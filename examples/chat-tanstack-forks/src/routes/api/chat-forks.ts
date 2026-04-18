import { createFileRoute } from "@tanstack/react-router"
import { ForkValidationError, createFork } from "~/lib/chat-session.server"

export const Route = createFileRoute(`/api/chat-forks`)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: any
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: `Invalid JSON body` }, { status: 400 })
        }

        const { sourceChatId, sourceMessageId, forkOffset } = body ?? {}

        if (
          typeof sourceChatId !== `string` ||
          typeof sourceMessageId !== `string` ||
          typeof forkOffset !== `string`
        ) {
          return Response.json(
            {
              error: `Missing required fields: sourceChatId, sourceMessageId, forkOffset`,
            },
            { status: 400 }
          )
        }

        try {
          const result = await createFork({
            sourceChatId,
            sourceMessageId,
            forkOffset,
          })

          return Response.json({ chat: result })
        } catch (error) {
          if (error instanceof ForkValidationError) {
            return Response.json({ error: error.message }, { status: 400 })
          }
          console.error(`Fork creation failed`, error)
          return Response.json(
            { error: `Fork creation failed` },
            { status: 500 }
          )
        }
      },
    },
  },
})

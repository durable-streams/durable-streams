/**
 * Webhook receiver — handles POST /api/webhook/agents
 *
 * The DS server sends webhook notifications here when streams
 * under /agents/* get new data. We verify the HMAC signature,
 * respond 200 immediately (so the consumer transitions to LIVE),
 * and fire-and-forget the agent worker.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { createFileRoute } from "@tanstack/react-router"
import { getWebhookSecret } from "../../server/setup"
import { processWake } from "../../server/agent-worker"

function verifySignature(
  body: string,
  header: string,
  secret: string
): boolean {
  const match = header.match(/t=(\d+),sha256=([a-f0-9]+)/)
  if (!match) return false
  const [, timestamp, signature] = match
  const payload = `${timestamp}.${body}`
  const expected = createHmac(`sha256`, secret).update(payload).digest(`hex`)
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

export const Route = createFileRoute(`/api/webhook/agents`)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.text()
        const sigHeader = request.headers.get(`webhook-signature`)

        const secret = getWebhookSecret()
        if (!secret) {
          console.log(
            `[webhook] Signature verification FAILED — no secret (server may have restarted)`
          )
          return new Response(`Unauthorized`, { status: 401 })
        }
        if (!sigHeader || !verifySignature(body, sigHeader, secret)) {
          console.log(`[webhook] Signature verification FAILED`)
          return new Response(`Unauthorized`, { status: 401 })
        }

        console.log(`[webhook] Signature verified`)
        const notification = JSON.parse(body)

        // Pass traceparent so agent spans link to the server's wake cycle trace
        const traceparent = request.headers.get(`traceparent`) ?? undefined

        // Respond 200 immediately so the consumer goes LIVE
        // Process the wake in the background
        processWake(notification, traceparent).catch((err) => {
          console.error(`[webhook] processWake error:`, err)
        })

        return Response.json({ ok: true })
      },
    },
  },
})

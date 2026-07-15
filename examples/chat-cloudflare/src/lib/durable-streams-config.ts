import { env } from "cloudflare:workers"
import { createStreamsHandler } from "@durable-streams/server-cloudflare"

/**
 * Server-side stream calls never leave this Worker: the StreamObject
 * binding lives here (src/server.ts), so requests go straight to an
 * in-process streams handler — no HTTP hop, and no "Worker cannot fetch
 * its own hostname" restriction when deployed. The host part of the URL
 * is a placeholder; only the path (the stream name) matters.
 */
export { buildChatStreamPath, buildStreamUrl } from "./chat-paths"

const streams = createStreamsHandler({
  // Internal calls originate from our own server routes — no auth hook.
  auth: () => undefined,
  cors: false,
})

/** Fetch for server-side stream calls — dispatches in-process. */
export const streamsFetch: typeof fetch = (input, init) =>
  streams(
    new Request(input, init),
    // Wrangler's generated binding type is unavailable to this example's tsc.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    env as unknown as Parameters<typeof streams>[1]
  )

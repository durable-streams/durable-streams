/**
 * Custom Worker entry: the TanStack Start app and the Durable Streams
 * server run in the same Worker. Stream access stays internal — server
 * routes call the streams handler in-process (see
 * src/lib/durable-streams-config.ts), and the browser reads through the
 * /api/chat-stream proxy — so the raw protocol (create/append/delete on
 * arbitrary streams) is never exposed to unauthenticated clients. The
 * StreamObject class still must be exported for the Durable Object
 * binding.
 */
import { env } from "cloudflare:workers"
import handler from "@tanstack/react-start/server-entry"
import { createChatWorker } from "~/lib/chat-worker"

export { StreamObject } from "@durable-streams/server-cloudflare"

export const worker = createChatWorker(
  handler,
  () => (env as { CHAT_AUTH_TOKEN?: string }).CHAT_AUTH_TOKEN
)

export default worker

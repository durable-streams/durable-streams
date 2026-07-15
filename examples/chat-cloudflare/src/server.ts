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
import handler from "@tanstack/react-start/server-entry"

export { StreamObject } from "@durable-streams/server-cloudflare"

export default {
  async fetch(request: Request): Promise<Response> {
    // TanStack Start doesn't take the Workers env through fetch args; the
    // Cloudflare plugin supplies it via the `cloudflare:workers` module.
    return handler.fetch(request)
  },
}

/**
 * Custom Worker entry: the TanStack Start app and the Durable Streams
 * server run in the same Worker. Requests under /streams/* are handled
 * by @durable-streams/server-cloudflare (one Durable Object per stream);
 * everything else goes to the TanStack Start handler.
 */
import handler from "@tanstack/react-start/server-entry"
import { createStreamsHandler } from "@durable-streams/server-cloudflare"

export { StreamObject } from "@durable-streams/server-cloudflare"

const streams = createStreamsHandler()

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === `/streams` || url.pathname.startsWith(`/streams/`)) {
      return streams(request, env as never)
    }
    // TanStack Start doesn't take the Workers env through fetch args; the
    // Cloudflare plugin supplies it via the `cloudflare:workers` module.
    return handler.fetch(request)
  },
}

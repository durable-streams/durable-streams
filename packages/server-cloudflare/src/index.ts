/**
 * Durable Streams server on Cloudflare Workers + Durable Objects.
 *
 * The Worker routes each stream path to its own StreamObject instance
 * (one Durable Object per stream via idFromName). All protocol semantics
 * live in the DO; the Worker handles routing, CORS, and auth hooks.
 */
import { StreamObject } from "./stream-object";

export { StreamObject };

export interface Env {
  STREAMS: DurableObjectNamespace<StreamObject>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const streamPath = url.pathname;

    if (streamPath === "/" || streamPath === "") {
      return new Response("Durable Streams server. Streams live at /<path>.", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    const id = env.STREAMS.idFromName(streamPath);
    const stub = env.STREAMS.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

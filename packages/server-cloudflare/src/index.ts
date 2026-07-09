/**
 * Durable Streams server on Cloudflare Workers + Durable Objects.
 *
 * The Worker routes each stream path to its own StreamObject instance
 * (one Durable Object per stream via idFromName). All protocol semantics
 * live in the DO; the Worker handles routing, CORS preflight, and the
 * bearer-token auth hook.
 */
import { StreamObject } from "./stream-object";

export { StreamObject };

export interface Env {
  STREAMS: DurableObjectNamespace<StreamObject>;
  /**
   * Optional bearer token. When set, every request must carry
   * `Authorization: Bearer <token>`. The protocol leaves auth to the
   * implementation; this is the hook.
   */
  AUTH_TOKEN?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, HEAD, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq, Stream-Forked-From, Stream-Fork-Offset, Stream-Fork-Sub-Offset",
  "access-control-expose-headers":
    "Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "cross-origin",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (env.AUTH_TOKEN !== undefined && env.AUTH_TOKEN !== "") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { ...CORS_HEADERS, "content-type": "text/plain" },
        });
      }
    }

    const url = new URL(request.url);
    const streamPath = url.pathname;

    if (streamPath === "/" || streamPath === "") {
      return new Response("Durable Streams server. Streams live at /<path>.", {
        status: 200,
        headers: { ...CORS_HEADERS, "content-type": "text/plain" },
      });
    }

    const id = env.STREAMS.idFromName(streamPath);
    const stub = env.STREAMS.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

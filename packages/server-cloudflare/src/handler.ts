/**
 * Worker-side router for the Durable Streams server.
 *
 * `createStreamsHandler` returns a fetch handler that routes each stream
 * path to its own StreamObject instance (one Durable Object per stream via
 * idFromName). All protocol semantics live in the DO; this layer handles
 * routing, CORS preflight, and the auth hook.
 */
import type { StreamsEnv } from "./stream-object";

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

export interface StreamsHandlerOptions<E extends StreamsEnv> {
  /**
   * Auth hook, called for every non-preflight request. Return a Response
   * to reject the request (CORS headers are added for you); return
   * undefined to let it through.
   *
   * When omitted, the default checks `env.AUTH_TOKEN`: if that var/secret
   * is set and non-empty, every request must carry
   * `Authorization: Bearer <token>`. The protocol leaves auth to the
   * implementation; this is the hook.
   */
  auth?: (
    request: Request,
    env: E,
  ) => Response | undefined | Promise<Response | undefined>;
  /** Set to false to omit the permissive default CORS headers. */
  cors?: boolean;
}

/** Env accepted by the default bearer-token auth hook. */
export interface DefaultAuthEnv extends StreamsEnv {
  AUTH_TOKEN?: string;
}

function defaultAuth(
  request: Request,
  env: DefaultAuthEnv,
): Response | undefined {
  if (env.AUTH_TOKEN === undefined || env.AUTH_TOKEN === "") return undefined;
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${env.AUTH_TOKEN}`) return undefined;
  return new Response("Unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain" },
  });
}

/**
 * Build the Worker fetch handler. Mount it alongside the exported DO class:
 *
 * ```ts
 * export { StreamObject } from "durable-object-streams";
 * export default { fetch: createStreamsHandler() };
 * ```
 *
 * with the required wrangler config (the binding must be named STREAMS):
 *
 * ```jsonc
 * "durable_objects": {
 *   "bindings": [{ "name": "STREAMS", "class_name": "StreamObject" }]
 * },
 * "migrations": [{ "tag": "v1", "new_sqlite_classes": ["StreamObject"] }]
 * ```
 *
 * The full request pathname is the stream path (streams live at `/<path>`);
 * route only the URLs you want to be streams at this handler if you mount
 * it inside a larger Worker.
 */
export function createStreamsHandler<E extends StreamsEnv = DefaultAuthEnv>(
  options: StreamsHandlerOptions<E> = {},
): (request: Request, env: E) => Promise<Response> {
  const cors = options.cors === false ? {} : CORS_HEADERS;
  const auth = options.auth ?? defaultAuth;

  return async (request: Request, env: E): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const rejection = await auth(request, env);
    if (rejection !== undefined) {
      const headers = new Headers(rejection.headers);
      for (const [name, value] of Object.entries(cors)) {
        if (!headers.has(name)) headers.set(name, value);
      }
      return new Response(rejection.body, {
        status: rejection.status,
        statusText: rejection.statusText,
        headers,
      });
    }

    const url = new URL(request.url);
    const streamPath = url.pathname;

    // `__ds` is the protocol's reserved control-plane prefix (§6): route it
    // before stream ops. Subscriptions are not implemented, so it 404s
    // rather than being treated as a stream path.
    if (streamPath.endsWith("/__ds") || streamPath.includes("/__ds/")) {
      return new Response("Subscription APIs are not supported", {
        status: 404,
        headers: { ...cors, "content-type": "text/plain" },
      });
    }

    if (streamPath === "/" || streamPath === "") {
      return new Response("Durable Streams server. Streams live at /<path>.", {
        status: 200,
        headers: { ...cors, "content-type": "text/plain" },
      });
    }

    const id = env.STREAMS.idFromName(streamPath);
    const stub = env.STREAMS.get(id);
    return stub.fetch(request);
  };
}

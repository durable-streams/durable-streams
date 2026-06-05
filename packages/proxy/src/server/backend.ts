/**
 * Backend URL and header helpers for the durable-streams proxy.
 *
 * Centralises how the proxy builds URLs and resolves headers for
 * all requests to the underlying durable-streams server.
 */

import type { ProxyServerOptions } from "./types"

/**
 * Build the full backend URL for a stream.
 *
 * Uses `options.streamPath` if provided, otherwise defaults to
 * `/v1/streams/${streamId}`.
 *
 * @param options - Proxy server options (needs `durableStreamsUrl` and optionally `streamPath`)
 * @param streamId - The stream ID
 * @returns Full URL string
 */
export function buildBackendUrl(
  options: Pick<ProxyServerOptions, `durableStreamsUrl` | `streamPath`>,
  streamId: string
): string {
  const path = options.streamPath
    ? options.streamPath(streamId)
    : `/v1/streams/${streamId}`
  return new URL(path, options.durableStreamsUrl).toString()
}

/**
 * Resolve backend headers for a request.
 *
 * If `options.backendHeaders` is a function, calls it with context.
 * If it's a static object, returns it directly.
 * If undefined, returns an empty object.
 *
 * @param options - Proxy server options (needs optionally `backendHeaders`)
 * @param ctx - Request context
 * @returns Headers to include on the backend request
 */
export async function resolveBackendHeaders(
  options: Pick<ProxyServerOptions, `backendHeaders`>,
  ctx: { streamId: string; method: string }
): Promise<Record<string, string>> {
  if (!options.backendHeaders) {
    return {}
  }
  if (typeof options.backendHeaders === `function`) {
    return options.backendHeaders(ctx)
  }
  return options.backendHeaders
}

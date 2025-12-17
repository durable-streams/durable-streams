/**
 * Middleware and utilities for creating protocol contexts.
 */

import { Hono } from "hono"
import { DurableStream } from "@durable-streams/client"
import type { ProtocolConfig, ProtocolHonoEnv } from "./types"

/**
 * Normalize a path by ensuring it starts with "/" and doesn't end with "/".
 */
function normalizePath(path: string): string {
  let normalized = path.trim()
  if (!normalized.startsWith(`/`)) {
    normalized = `/` + normalized
  }
  if (normalized.endsWith(`/`) && normalized.length > 1) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/**
 * Combine namespace and subpath into a full stream path.
 */
function resolvePath(namespace: string, subpath: string): string {
  const normalizedNamespace = normalizePath(namespace)
  let normalizedSubpath = subpath.trim()

  // Handle empty subpath
  if (!normalizedSubpath) {
    return normalizedNamespace
  }

  // Ensure subpath starts with /
  if (!normalizedSubpath.startsWith(`/`)) {
    normalizedSubpath = `/` + normalizedSubpath
  }

  return normalizedNamespace + normalizedSubpath
}

/**
 * Create a middleware that sets up the stream context for protocol handlers.
 * This middleware adds a `stream()` function to the Hono context that creates
 * DurableStream handles scoped to the protocol's namespace.
 */
export function createStreamMiddleware(
  namespace: string,
  config: ProtocolConfig
): import("hono").MiddlewareHandler<ProtocolHonoEnv> {
  const normalizedNamespace = normalizePath(namespace)

  return async (c, next) => {
    // Set the namespace on the context
    c.set(`namespace`, normalizedNamespace)

    // Set the stream factory function
    c.set(`stream`, (subpath: string) => {
      const fullPath = resolvePath(normalizedNamespace, subpath)
      const url = `${config.baseUrl}${fullPath}`

      return new DurableStream({
        url,
        headers: config.headers,
        fetch: config.fetch,
      })
    })

    await next()
  }
}

/**
 * Create a protocol app with the stream middleware already applied.
 */
export function createProtocolApp(
  namespace: string,
  config: ProtocolConfig
): Hono<ProtocolHonoEnv> {
  const app = new Hono<ProtocolHonoEnv>()
  app.use(`*`, createStreamMiddleware(namespace, config))
  return app
}

/**
 * Helper to get a stream handle from the Hono context.
 */
export function getStream(
  c: import("hono").Context<ProtocolHonoEnv>,
  subpath: string
): DurableStream {
  const streamFn = c.get(`stream`)
  return streamFn(subpath)
}

/**
 * Helper to get the namespace from the Hono context.
 */
export function getNamespace(c: import("hono").Context<ProtocolHonoEnv>): string {
  return c.get(`namespace`)
}

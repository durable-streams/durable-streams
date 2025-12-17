/**
 * Helper functions for defining protocols.
 */

import type {
  Protocol,
  ProtocolHandler,
  ProtocolRequest,
  ProtocolResponse,
  StreamContext,
  StreamInfo,
  HttpMethod,
} from "./types"

/**
 * Options for defining a protocol.
 */
export interface DefineProtocolOptions {
  /** Unique name for this protocol */
  name: string

  /** Namespace pattern (e.g., "/yjs/:docId/*") */
  namespace: string

  /** Request handler */
  handle: ProtocolHandler

  /** Optional lifecycle hooks */
  hooks?: Protocol[`hooks`]
}

/**
 * Define a protocol with type inference.
 */
export function defineProtocol(options: DefineProtocolOptions): Protocol {
  return {
    name: options.name,
    namespace: options.namespace,
    handle: options.handle,
    hooks: options.hooks,
  }
}

/**
 * Route handler for specific method + subpath combinations.
 */
export interface RouteHandler {
  method: HttpMethod | HttpMethod[]
  path?: string | RegExp
  handler: ProtocolHandler
}

/**
 * Builder for creating protocols with route-based handlers.
 */
export class ProtocolBuilder {
  private routes: RouteHandler[] = []
  private hooks: NonNullable<Protocol[`hooks`]> = {}

  constructor(
    private name: string,
    private namespace: string
  ) {}

  /**
   * Add a route handler.
   */
  route(
    method: HttpMethod | HttpMethod[],
    path: string | RegExp | null,
    handler: ProtocolHandler
  ): this {
    this.routes.push({
      method,
      path: path ?? undefined,
      handler,
    })
    return this
  }

  /**
   * Handle GET requests.
   */
  get(path: string | RegExp | null, handler: ProtocolHandler): this {
    return this.route(`GET`, path, handler)
  }

  /**
   * Handle POST requests.
   */
  post(path: string | RegExp | null, handler: ProtocolHandler): this {
    return this.route(`POST`, path, handler)
  }

  /**
   * Handle PUT requests.
   */
  put(path: string | RegExp | null, handler: ProtocolHandler): this {
    return this.route(`PUT`, path, handler)
  }

  /**
   * Handle DELETE requests.
   */
  delete(path: string | RegExp | null, handler: ProtocolHandler): this {
    return this.route(`DELETE`, path, handler)
  }

  /**
   * Handle all methods for a path.
   */
  all(path: string | RegExp | null, handler: ProtocolHandler): this {
    return this.route([`GET`, `POST`, `PUT`, `DELETE`, `HEAD`], path, handler)
  }

  /**
   * Add stream created hook.
   */
  onStreamCreated(
    handler: (info: StreamInfo, context: StreamContext) => Promise<void>
  ): this {
    this.hooks.onStreamCreated = handler
    return this
  }

  /**
   * Add stream deleted hook.
   */
  onStreamDeleted(
    handler: (path: string, context: StreamContext) => Promise<void>
  ): this {
    this.hooks.onStreamDeleted = handler
    return this
  }

  /**
   * Add register hook.
   */
  onRegister(handler: (context: StreamContext) => Promise<void>): this {
    this.hooks.onRegister = handler
    return this
  }

  /**
   * Add unregister hook.
   */
  onUnregister(handler: (context: StreamContext) => Promise<void>): this {
    this.hooks.onUnregister = handler
    return this
  }

  /**
   * Build the protocol.
   */
  build(): Protocol {
    const routes = this.routes
    const hooks = Object.keys(this.hooks).length > 0 ? this.hooks : undefined

    return {
      name: this.name,
      namespace: this.namespace,
      hooks,
      handle: async (request, context) => {
        // Find matching route
        for (const route of routes) {
          if (!this.methodMatches(route.method, request.method)) {
            continue
          }

          if (!this.pathMatches(route.path, request.subpath)) {
            continue
          }

          return route.handler(request, context)
        }

        // No route matched - pass through to default handling
        return undefined
      },
    }
  }

  private methodMatches(
    routeMethod: HttpMethod | HttpMethod[],
    requestMethod: HttpMethod
  ): boolean {
    if (Array.isArray(routeMethod)) {
      return routeMethod.includes(requestMethod)
    }
    return routeMethod === requestMethod
  }

  private pathMatches(
    routePath: string | RegExp | undefined,
    requestPath: string
  ): boolean {
    if (routePath === undefined) {
      return true
    }

    if (typeof routePath === `string`) {
      // Exact match or wildcard match
      if (routePath === `*`) return true
      if (routePath === requestPath) return true
      if (routePath.endsWith(`/*`)) {
        const prefix = routePath.slice(0, -2)
        return requestPath.startsWith(prefix)
      }
      return false
    }

    // Regex match
    return routePath.test(requestPath)
  }
}

/**
 * Create a protocol builder.
 */
export function createProtocolBuilder(
  name: string,
  namespace: string
): ProtocolBuilder {
  return new ProtocolBuilder(name, namespace)
}

/**
 * Helper to create a JSON response.
 */
export function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>
): ProtocolResponse {
  return {
    status,
    headers: {
      "content-type": `application/json`,
      ...headers,
    },
    body: JSON.stringify(data),
  }
}

/**
 * Helper to create an error response.
 */
export function errorResponse(
  message: string,
  status = 400,
  details?: unknown
): ProtocolResponse {
  return {
    status,
    headers: {
      "content-type": `application/json`,
    },
    body: JSON.stringify({
      error: message,
      details,
    }),
  }
}

/**
 * Helper to create a redirect response.
 */
export function redirectResponse(
  location: string,
  status: 301 | 302 | 307 | 308 = 302
): ProtocolResponse {
  return {
    status,
    headers: {
      location,
    },
  }
}

/**
 * Helper to validate required request body.
 */
export function requireBody(request: ProtocolRequest): Uint8Array {
  if (!request.body || request.body.length === 0) {
    throw new RequestError(`Request body is required`, 400)
  }
  return request.body
}

/**
 * Helper to parse JSON body.
 */
export function parseJsonBody<T = unknown>(request: ProtocolRequest): T {
  const body = requireBody(request)
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T
  } catch {
    throw new RequestError(`Invalid JSON body`, 400)
  }
}

/**
 * Error that can be thrown in handlers to return an error response.
 */
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public details?: unknown
  ) {
    super(message)
    this.name = `RequestError`
  }

  toResponse(): ProtocolResponse {
    return errorResponse(this.message, this.status, this.details)
  }
}

/**
 * Wrap a handler to catch RequestErrors and convert them to responses.
 */
export function catchErrors(handler: ProtocolHandler): ProtocolHandler {
  return async (request, context) => {
    try {
      return await handler(request, context)
    } catch (error) {
      if (error instanceof RequestError) {
        return error.toResponse()
      }
      throw error
    }
  }
}

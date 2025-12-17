/**
 * Protocol dispatcher that routes requests to registered protocol handlers.
 */

import type {
  Protocol,
  ProtocolRequest,
  ProtocolResponse,
  ProtocolMatch,
  DispatcherConfig,
  HttpMethod,
  StreamContext,
  SSEEvent,
} from "./types"
import { createStreamContext, type StoreAdapter } from "./context"

/**
 * Compiled pattern for efficient matching.
 */
interface CompiledPattern {
  /** Original pattern string */
  pattern: string

  /** Regex for matching */
  regex: RegExp

  /** Named parameter names in order */
  paramNames: string[]

  /** Whether pattern ends with wildcard */
  hasWildcard: boolean

  /** Base namespace path (without params/wildcards) */
  basePath: string
}

/**
 * Compile a namespace pattern into a regex for matching.
 *
 * Supports:
 * - Exact match: "/yjs"
 * - Wildcard suffix: "/yjs/*"
 * - Named params: "/yjs/:docId"
 * - Combined: "/yjs/:docId/*"
 */
function compilePattern(pattern: string): CompiledPattern {
  const paramNames: string[] = []
  let hasWildcard = false
  let basePath = ``

  // Normalize pattern
  let normalized = pattern.trim()
  if (!normalized.startsWith(`/`)) {
    normalized = `/` + normalized
  }

  // Build regex pattern
  let regexStr = `^`
  const parts = normalized.split(`/`).filter(Boolean)

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!

    if (part === `*`) {
      // Wildcard - capture everything after
      hasWildcard = true
      regexStr += `(?:/(.*))?`
      break
    } else if (part.startsWith(`:`)) {
      // Named parameter
      const paramName = part.slice(1)
      paramNames.push(paramName)
      regexStr += `/([^/]+)`
    } else {
      // Literal segment
      basePath += `/` + part
      regexStr += `/` + escapeRegex(part)
    }
  }

  // If no wildcard, allow optional trailing segments for subpaths
  if (!hasWildcard) {
    regexStr += `(?:/(.*))?`
    hasWildcard = true // Implicit wildcard for subpath capture
  }

  regexStr += `$`

  return {
    pattern: normalized,
    regex: new RegExp(regexStr),
    paramNames,
    hasWildcard,
    basePath: basePath || `/`,
  }
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)
}

/**
 * Match a path against a compiled pattern.
 */
function matchPattern(
  path: string,
  compiled: CompiledPattern
): { params: Record<string, string>; wildcard?: string; subpath: string } | null {
  const match = compiled.regex.exec(path)
  if (!match) {
    return null
  }

  const params: Record<string, string> = {}

  // Extract named parameters
  for (let i = 0; i < compiled.paramNames.length; i++) {
    const value = match[i + 1]
    if (value !== undefined) {
      params[compiled.paramNames[i]!] = value
    }
  }

  // Extract wildcard (last capture group)
  const wildcardIndex = compiled.paramNames.length + 1
  const wildcard = match[wildcardIndex]

  // Calculate subpath (path relative to namespace)
  let subpath = path.slice(compiled.basePath.length)
  if (!subpath.startsWith(`/`)) {
    subpath = `/` + subpath
  }

  return {
    params,
    wildcard: wildcard || undefined,
    subpath,
  }
}

/**
 * Registered protocol with compiled pattern.
 */
interface RegisteredProtocol {
  protocol: Protocol
  compiled: CompiledPattern
  context: StreamContext
}

/**
 * Protocol dispatcher that routes requests to the appropriate handler.
 */
export class ProtocolDispatcher {
  private protocols: RegisteredProtocol[] = []
  private store: StoreAdapter
  private config: Required<DispatcherConfig>

  constructor(store: StoreAdapter, config: DispatcherConfig = {}) {
    this.store = store
    this.config = {
      basePath: config.basePath ?? `/v1/stream`,
      defaultHandler: config.defaultHandler ?? (async () => ({ status: 404, body: `Not found` })),
    }
  }

  /**
   * Register a protocol handler for a namespace.
   */
  async register(protocol: Protocol): Promise<void> {
    // Check for conflicts
    const compiled = compilePattern(protocol.namespace)
    for (const existing of this.protocols) {
      if (this.patternsConflict(compiled, existing.compiled)) {
        throw new Error(
          `Protocol "${protocol.name}" namespace "${protocol.namespace}" ` +
          `conflicts with existing protocol "${existing.protocol.name}" ` +
          `namespace "${existing.protocol.namespace}"`
        )
      }
    }

    // Create scoped context for this protocol
    const context = createStreamContext({
      namespace: compiled.basePath,
      store: this.store,
      onStreamCreated: protocol.hooks?.onStreamCreated
        ? (info) => protocol.hooks!.onStreamCreated!(info, context)
        : undefined,
      onStreamDeleted: protocol.hooks?.onStreamDeleted
        ? (path) => protocol.hooks!.onStreamDeleted!(path, context)
        : undefined,
    })

    const registered: RegisteredProtocol = {
      protocol,
      compiled,
      context,
    }

    // Insert sorted by specificity (more specific patterns first)
    const insertIndex = this.protocols.findIndex(
      (p) => this.patternSpecificity(compiled) > this.patternSpecificity(p.compiled)
    )
    if (insertIndex === -1) {
      this.protocols.push(registered)
    } else {
      this.protocols.splice(insertIndex, 0, registered)
    }

    // Call registration hook
    if (protocol.hooks?.onRegister) {
      await protocol.hooks.onRegister(context)
    }
  }

  /**
   * Unregister a protocol.
   */
  async unregister(protocolName: string): Promise<boolean> {
    const index = this.protocols.findIndex((p) => p.protocol.name === protocolName)
    if (index === -1) {
      return false
    }

    const registered = this.protocols[index]!
    this.protocols.splice(index, 1)

    // Call unregistration hook
    if (registered.protocol.hooks?.onUnregister) {
      await registered.protocol.hooks.onUnregister(registered.context)
    }

    return true
  }

  /**
   * Get a registered protocol by name.
   */
  getProtocol(name: string): Protocol | undefined {
    return this.protocols.find((p) => p.protocol.name === name)?.protocol
  }

  /**
   * List all registered protocols.
   */
  listProtocols(): Protocol[] {
    return this.protocols.map((p) => p.protocol)
  }

  /**
   * Match a path to a protocol.
   */
  match(path: string): ProtocolMatch | null {
    // Strip base path prefix
    let relativePath = path
    if (this.config.basePath && path.startsWith(this.config.basePath)) {
      relativePath = path.slice(this.config.basePath.length)
    }
    if (!relativePath.startsWith(`/`)) {
      relativePath = `/` + relativePath
    }

    for (const registered of this.protocols) {
      const result = matchPattern(relativePath, registered.compiled)
      if (result) {
        return {
          protocol: registered.protocol,
          params: result.params,
          wildcard: result.wildcard,
          subpath: result.subpath,
        }
      }
    }

    return null
  }

  /**
   * Dispatch a request to the appropriate protocol handler.
   */
  async dispatch(
    method: HttpMethod,
    path: string,
    options: {
      url: URL
      headers: Headers
      body?: Uint8Array
    }
  ): Promise<ProtocolResponse> {
    // Find matching protocol
    const match = this.match(path)

    if (!match) {
      // No protocol matched - use default handler
      const request = this.buildRequest(method, path, options, {
        params: {},
        subpath: path,
      })

      // Create a generic context for the default handler
      const context = createStreamContext({
        namespace: `/`,
        store: this.store,
      })

      const response = await this.config.defaultHandler(request, context)
      return response ?? { status: 404, body: `Not found` }
    }

    // Build request object
    const request = this.buildRequest(method, path, options, match)

    // Get the registered protocol entry to access its context
    const registered = this.protocols.find(
      (p) => p.protocol.name === match.protocol.name
    )!

    // Call protocol handler
    const response = await match.protocol.handle(request, registered.context)

    // If handler returns void, it means "pass through to default stream handling"
    if (response === undefined || response === null) {
      return { status: 200, body: `` } // Passthrough indicator
    }

    return response
  }

  /**
   * Create a request handler function for use with HTTP servers.
   */
  createHandler(): (
    method: HttpMethod,
    url: URL,
    headers: Headers,
    body?: Uint8Array
  ) => Promise<ProtocolResponse> {
    return async (method, url, headers, body) => {
      return this.dispatch(method, url.pathname, { url, headers, body })
    }
  }

  /**
   * Get the context for a specific protocol (for testing/debugging).
   */
  getContext(protocolName: string): StreamContext | undefined {
    return this.protocols.find((p) => p.protocol.name === protocolName)?.context
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private buildRequest(
    method: HttpMethod,
    path: string,
    options: { url: URL; headers: Headers; body?: Uint8Array },
    matchResult: { params: Record<string, string>; wildcard?: string; subpath: string }
  ): ProtocolRequest {
    return {
      method,
      path,
      subpath: matchResult.subpath,
      url: options.url,
      headers: options.headers,
      body: options.body,
      params: matchResult.params,
      wildcard: matchResult.wildcard,
    }
  }

  private patternsConflict(a: CompiledPattern, b: CompiledPattern): boolean {
    // Two patterns conflict if they have the same base path
    // More sophisticated conflict detection could be added
    return a.basePath === b.basePath
  }

  private patternSpecificity(pattern: CompiledPattern): number {
    // More specific patterns have:
    // - Longer base paths
    // - More named parameters
    // - No wildcard
    let score = pattern.basePath.length * 10
    score += pattern.paramNames.length * 5
    if (!pattern.hasWildcard) {
      score += 100
    }
    return score
  }
}

/**
 * Create a protocol dispatcher.
 */
export function createDispatcher(
  store: StoreAdapter,
  config?: DispatcherConfig
): ProtocolDispatcher {
  return new ProtocolDispatcher(store, config)
}

/**
 * Helper to format an SSE event.
 */
export function formatSSEEvent(event: SSEEvent): string {
  let result = ``

  if (event.event) {
    result += `event: ${event.event}\n`
  }

  if (event.id) {
    result += `id: ${event.id}\n`
  }

  if (event.retry !== undefined) {
    result += `retry: ${event.retry}\n`
  }

  const data = typeof event.data === `string` ? event.data : JSON.stringify(event.data)
  // Handle multiline data
  const lines = data.split(`\n`)
  for (const line of lines) {
    result += `data: ${line}\n`
  }

  result += `\n`
  return result
}

/**
 * Helper to create a streaming SSE response.
 */
export async function* streamSSE(
  events: AsyncIterable<SSEEvent>
): AsyncGenerator<string> {
  for await (const event of events) {
    yield formatSSEEvent(event)
  }
}

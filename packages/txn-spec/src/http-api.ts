/**
 * HTTP API for Transactional Storage
 *
 * Implements a stateless batch transaction API over HTTP.
 * All operations in a batch execute as a single ACID transaction.
 *
 * Key features:
 * - Stateless: No session management, each request is independent
 * - Idempotent: Optional idempotency keys for exactly-once semantics
 * - Batch: Multiple reads/writes in a single request
 * - Low latency: Single round-trip for entire transaction
 */

import { createServer as createHttpServer } from "node:http"
import { isBottom } from "./types"
import { assign, del, increment } from "./effects"
import { createTransactionCoordinator } from "./transaction"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { TransactionCoordinator } from "./transaction"
import type { Effect, EffectOrBottom, Key, Timestamp, Value } from "./types"
import type { StreamStore } from "./store"

// =============================================================================
// API Types
// =============================================================================

/**
 * Serialized effect in request/response.
 */
export type SerializedEffect =
  | { type: `assign`; value: Value }
  | { type: `increment`; delta: number }
  | { type: `delete` }

/**
 * A single operation in a batch.
 */
export type BatchOperation =
  | { op: `read`; key: Key }
  | { op: `update`; key: Key; effect: SerializedEffect }

/**
 * Batch transaction request.
 */
export interface BatchRequest {
  /**
   * Optional snapshot timestamp. If omitted, uses current time.
   */
  snapshotTs?: Timestamp

  /**
   * Operations to execute in the transaction.
   * Executed in order, reads see prior writes in the batch.
   */
  operations: Array<BatchOperation>

  /**
   * Optional idempotency key for exactly-once semantics.
   * If provided, duplicate requests with the same key return cached results.
   */
  idempotencyKey?: string
}

/**
 * Read result in the response.
 */
export interface ReadResult {
  key: Key
  value: Value | null // null = BOTTOM (key doesn't exist)
}

/**
 * Batch transaction response.
 */
export interface BatchResponse {
  /**
   * Whether the transaction committed successfully.
   */
  success: boolean

  /**
   * Transaction ID.
   */
  txnId: string

  /**
   * Snapshot timestamp used.
   */
  snapshotTs: Timestamp

  /**
   * Commit timestamp (if successful).
   */
  commitTs?: Timestamp

  /**
   * Results of read operations, in order.
   */
  reads: Array<ReadResult>

  /**
   * Error message (if failed).
   */
  error?: string

  /**
   * Whether this response was from idempotency cache.
   */
  cached?: boolean
}

/**
 * Error response.
 */
export interface ErrorResponse {
  error: string
  code: string
}

// =============================================================================
// Effect Conversion
// =============================================================================

/**
 * Convert serialized effect to internal effect.
 */
function deserializeEffect(serialized: SerializedEffect): Effect {
  switch (serialized.type) {
    case `assign`:
      return assign(serialized.value)
    case `increment`:
      return increment(serialized.delta)
    case `delete`:
      return del()
  }
}

/**
 * Convert internal value to API value.
 */
function valueToApi(value: EffectOrBottom): Value | null {
  if (isBottom(value)) {
    return null
  }
  // For effects, we need to extract the value
  // After isBottom check, value is Effect, which is always an object with `type`
  const effect = value
  if (effect.type === `assign`) {
    return effect.value
  }
  // For other effect types (increment, delete, custom), return the effect
  return value as Value
}

// =============================================================================
// Idempotency Cache
// =============================================================================

interface CachedResponse {
  response: BatchResponse
  expiresAt: number
}

/**
 * Simple in-memory idempotency cache.
 * In production, use Redis or similar.
 */
class IdempotencyCache {
  private cache = new Map<string, CachedResponse>()
  private readonly ttlMs: number

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    // Default: 24 hours
    this.ttlMs = ttlMs
  }

  get(key: string): BatchResponse | undefined {
    const cached = this.cache.get(key)
    if (!cached) return undefined
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    return cached.response
  }

  set(key: string, response: BatchResponse): void {
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  // Cleanup expired entries (call periodically)
  cleanup(): void {
    const now = Date.now()
    for (const [key, cached] of this.cache) {
      if (now > cached.expiresAt) {
        this.cache.delete(key)
      }
    }
  }
}

// =============================================================================
// Transaction Executor
// =============================================================================

/**
 * Execute a batch transaction.
 */
export function executeBatch(
  coordinator: TransactionCoordinator,
  request: BatchRequest
): BatchResponse {
  const reads: Array<ReadResult> = []

  // Begin transaction
  const txn = coordinator.begin(undefined, request.snapshotTs)

  try {
    // Execute operations in order
    for (const op of request.operations) {
      switch (op.op) {
        case `read`: {
          const value = coordinator.read(txn.id, op.key)
          reads.push({
            key: op.key,
            value: valueToApi(value),
          })
          break
        }
        case `update`: {
          const effect = deserializeEffect(op.effect)
          coordinator.update(txn.id, op.key, effect)
          break
        }
      }
    }

    // Commit
    const commitTs = coordinator.commit(txn.id)

    return {
      success: true,
      txnId: txn.id,
      snapshotTs: txn.snapshotTs,
      commitTs,
      reads,
    }
  } catch (err) {
    // Abort on error
    try {
      coordinator.abort(txn.id)
    } catch {
      // Ignore abort errors
    }

    return {
      success: false,
      txnId: txn.id,
      snapshotTs: txn.snapshotTs,
      reads,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// =============================================================================
// HTTP Handler
// =============================================================================

/**
 * Options for the HTTP API.
 */
export interface HttpApiOptions {
  /**
   * The store to use.
   */
  store: StreamStore

  /**
   * Enable idempotency cache.
   * @default true
   */
  idempotency?: boolean

  /**
   * Idempotency cache TTL in milliseconds.
   * @default 86400000 (24 hours)
   */
  idempotencyTtlMs?: number

  /**
   * CORS origin. Set to "*" for all origins, or specific origin.
   * @default undefined (no CORS headers)
   */
  cors?: string
}

/**
 * Create an HTTP request handler for the transaction API.
 */
export function createHttpHandler(options: HttpApiOptions): {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  coordinator: TransactionCoordinator
} {
  const { store, idempotency = true, idempotencyTtlMs, cors } = options

  const coordinator = createTransactionCoordinator(store)
  const cache = idempotency ? new IdempotencyCache(idempotencyTtlMs) : undefined

  // Cleanup cache periodically
  if (cache) {
    setInterval(() => cache.cleanup(), 60 * 1000)
  }

  async function handler(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // CORS headers
    if (cors) {
      res.setHeader(`Access-Control-Allow-Origin`, cors)
      res.setHeader(`Access-Control-Allow-Methods`, `POST, OPTIONS`)
      res.setHeader(
        `Access-Control-Allow-Headers`,
        `Content-Type, X-Idempotency-Key`
      )
    }

    // Handle preflight
    if (req.method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    // Parse URL
    const url = new URL(req.url ?? `/`, `http://localhost`)
    const path = url.pathname

    // Route: POST /txn/batch
    if (req.method === `POST` && path === `/txn/batch`) {
      await handleBatch(req, res, coordinator, cache)
      return
    }

    // Route: GET /health
    if (req.method === `GET` && path === `/health`) {
      sendJson(res, 200, { status: `ok` })
      return
    }

    // 404
    sendJson(res, 404, { error: `Not found`, code: `NOT_FOUND` })
  }

  return { handler, coordinator }
}

/**
 * Handle POST /txn/batch
 */
async function handleBatch(
  req: IncomingMessage,
  res: ServerResponse,
  coordinator: TransactionCoordinator,
  cache?: IdempotencyCache
): Promise<void> {
  // Parse body
  let body: BatchRequest
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw) as BatchRequest
  } catch {
    sendJson(res, 400, {
      error: `Invalid JSON body`,
      code: `INVALID_JSON`,
    })
    return
  }

  // Validate request - runtime check since JSON parsing doesn't guarantee type safety
  const operations = body.operations as unknown
  if (!operations || !Array.isArray(operations)) {
    sendJson(res, 400, {
      error: `Missing or invalid 'operations' array`,
      code: `INVALID_REQUEST`,
    })
    return
  }

  // Check idempotency cache
  const idempotencyKey =
    body.idempotencyKey ?? req.headers[`x-idempotency-key`]?.toString()
  if (idempotencyKey && cache) {
    const cached = cache.get(idempotencyKey)
    if (cached) {
      sendJson(res, 200, { ...cached, cached: true })
      return
    }
  }

  // Execute batch
  const response = executeBatch(coordinator, body)

  // Store in idempotency cache
  if (idempotencyKey && cache && response.success) {
    cache.set(idempotencyKey, response)
  }

  // Send response
  const status = response.success ? 200 : 409
  sendJson(res, status, response)
}

/**
 * Read request body as string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on(`data`, (chunk: Buffer) => chunks.push(chunk))
    req.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf-8`)))
    req.on(`error`, reject)
  })
}

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": `application/json` })
  res.end(JSON.stringify(data))
}

// =============================================================================
// Server Factory
// =============================================================================

/**
 * Options for creating a server.
 */
export interface ServerOptions extends HttpApiOptions {
  /**
   * Port to listen on.
   * @default 3000
   */
  port?: number

  /**
   * Host to bind to.
   * @default "localhost"
   */
  host?: string
}

/**
 * Create and start an HTTP server.
 */
export function createServer(options: ServerOptions): {
  server: ReturnType<typeof createHttpServer>
  coordinator: TransactionCoordinator
  close: () => Promise<void>
  address: () => { host: string; port: number }
} {
  const { port = 3000, host = `localhost`, ...apiOptions } = options

  const { handler, coordinator } = createHttpHandler(apiOptions)

  const server = createHttpServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error(`Unhandled error:`, err)
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: `Internal server error`,
          code: `INTERNAL_ERROR`,
        })
      }
    })
  })

  server.listen(port, host)

  return {
    server,
    coordinator,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
    address: () => ({ host, port }),
  }
}

// =============================================================================
// Exports
// =============================================================================

export { BOTTOM } from "./types"

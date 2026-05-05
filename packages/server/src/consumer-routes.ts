/**
 * HTTP handlers for Layer 1: Named Consumers.
 * Routes:
 *   POST   /consumers             — Register a consumer
 *   GET    /consumers/{id}        — Get consumer state
 *   POST   /consumers/{id}/acquire — Acquire epoch
 *   POST   /consumers/{id}/ack     — Acknowledge offsets (empty offsets = heartbeat)
 *   POST   /consumers/{id}/release — Release epoch
 *   DELETE /consumers/{id}        — Deregister consumer
 */

import type { ConsumerManager } from "./consumer-manager"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { PullWakeManager } from "./pull-wake-manager"
import type { WebhookManager } from "./webhook-manager"
import type { AckRequest, WakePreference } from "./consumer-types"

const ERROR_CODE_TO_STATUS: Record<string, number> = {
  CONSUMER_NOT_FOUND: 404,
  CONSUMER_ALREADY_EXISTS: 409,
  EPOCH_HELD: 409,
  STALE_EPOCH: 409,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  OFFSET_REGRESSION: 409,
  INVALID_OFFSET: 409,
  UNKNOWN_STREAM: 400,
  INTERNAL_ERROR: 500,
}

export class ConsumerRoutes {
  private manager: ConsumerManager
  private webhookManager: WebhookManager | null
  private pullWakeManager: PullWakeManager | null

  constructor(
    manager: ConsumerManager,
    opts?: {
      webhookManager?: WebhookManager | null
      pullWakeManager?: PullWakeManager | null
    }
  ) {
    this.manager = manager
    this.webhookManager = opts?.webhookManager ?? null
    this.pullWakeManager = opts?.pullWakeManager ?? null
  }

  /**
   * Try to handle a request as a consumer route.
   * Returns true if handled, false to pass through.
   */
  async handleRequest(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    if (!path.startsWith(`/consumers`)) return false

    // POST /consumers — register
    if (path === `/consumers` && method === `POST`) {
      await this.handleRegister(req, res)
      return true
    }

    // Parse /consumers/{id} and /consumers/{id}/{action}
    const segments = path.slice(`/consumers/`.length).split(`/`)
    if (segments.length === 0 || !segments[0]) return false

    const consumerId = decodeURIComponent(segments[0])
    const action = segments[1] // acquire, ack, release, or undefined

    if (!action) {
      // GET /consumers/{id}
      if (method === `GET`) {
        this.handleGet(consumerId, res)
        return true
      }
      // DELETE /consumers/{id}
      if (method === `DELETE`) {
        this.handleDelete(consumerId, res)
        return true
      }
      return false
    }

    // PUT /consumers/{id}/wake
    if (segments.length === 2 && segments[1] === `wake` && method === `PUT`) {
      await this.handleSetWakePreference(consumerId, req, res)
      return true
    }

    if (method !== `POST`) {
      res.writeHead(405, { "content-type": `text/plain` })
      res.end(`Method not allowed`)
      return true
    }

    switch (action) {
      case `acquire`:
        await this.handleAcquire(consumerId, req, res)
        return true
      case `ack`:
        await this.handleAck(consumerId, req, res)
        return true
      case `release`:
        this.handleRelease(consumerId, req, res)
        return true
      default:
        return false
    }
  }

  // ============================================================================
  // Handlers
  // ============================================================================

  private async handleRegister(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let parsed: unknown

    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
        })
      )
      return
    }

    if (typeof parsed !== `object` || parsed === null) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
        })
      )
      return
    }

    const payload = parsed as {
      consumer_id?: unknown
      streams?: unknown
      namespace?: unknown
      lease_ttl_ms?: unknown
    }

    if (
      typeof payload.consumer_id !== `string` ||
      payload.consumer_id.length === 0
    ) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `Missing required field: consumer_id`,
          },
        })
      )
      return
    }

    if (payload.consumer_id.startsWith(`__wh__:`)) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `consumer_id must not start with reserved prefix '__wh__:'`,
          },
        })
      )
      return
    }

    if (
      !Array.isArray(payload.streams) ||
      payload.streams.length === 0 ||
      payload.streams.some(
        (path) => typeof path !== `string` || path.length === 0
      )
    ) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `Missing required field: streams`,
          },
        })
      )
      return
    }

    if (
      payload.namespace !== undefined &&
      (typeof payload.namespace !== `string` || payload.namespace.length === 0)
    ) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `namespace must be a non-empty string when provided`,
          },
        })
      )
      return
    }

    if (
      payload.lease_ttl_ms !== undefined &&
      (typeof payload.lease_ttl_ms !== `number` ||
        !Number.isInteger(payload.lease_ttl_ms) ||
        payload.lease_ttl_ms <= 0)
    ) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `lease_ttl_ms must be a positive integer when provided`,
          },
        })
      )
      return
    }

    const namespace =
      typeof payload.namespace === `string` ? payload.namespace : undefined
    const leaseTtlMs =
      typeof payload.lease_ttl_ms === `number`
        ? payload.lease_ttl_ms
        : undefined

    const result = this.manager.registerConsumer(
      payload.consumer_id,
      payload.streams as Array<string>,
      {
        namespace,
        lease_ttl_ms: leaseTtlMs,
      }
    )

    if (`error` in result) {
      res.writeHead(409, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `CONSUMER_ALREADY_EXISTS`,
            message: `Consumer already exists with different configuration`,
          },
        })
      )
      return
    }

    const info = this.manager.getConsumer(result.consumer.consumer_id)
    res.writeHead(result.created ? 201 : 200, {
      "content-type": `application/json`,
    })
    res.end(JSON.stringify(info))
  }

  private handleGet(consumerId: string, res: ServerResponse): void {
    const info = this.manager.getConsumer(consumerId)
    if (!info) {
      res.writeHead(404, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `CONSUMER_NOT_FOUND`, message: `Consumer not found` },
        })
      )
      return
    }

    const webhookConsumer =
      this.webhookManager?.store.getWebhookConsumer(consumerId)
    const response = {
      ...info,
      ...(webhookConsumer
        ? {
            webhook: {
              wake_id: webhookConsumer.wake_id ?? null,
              subscription_id: webhookConsumer.subscription_id,
            },
          }
        : {}),
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(response))
  }

  private handleDelete(consumerId: string, res: ServerResponse): void {
    const removed = this.manager.deleteConsumer(consumerId)
    if (!removed) {
      res.writeHead(404, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `CONSUMER_NOT_FOUND`, message: `Consumer not found` },
        })
      )
      return
    }
    res.writeHead(204)
    res.end()
  }

  private async handleAcquire(
    consumerId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Read optional body for worker field
    let worker: string | undefined
    const body = await this.readBody(req)
    if (body.length > 0) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(new TextDecoder().decode(body))
      } catch {
        res.writeHead(400, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
          })
        )
        return
      }
      if (parsed.worker && typeof parsed.worker === `string`) {
        worker = parsed.worker
      }
    }

    const result = this.manager.acquire(consumerId, worker)

    if (`error` in result) {
      const status = ERROR_CODE_TO_STATUS[result.error.code] ?? 500
      const headers: Record<string, string> = {
        "content-type": `application/json`,
      }
      if (result.error.retry_after) {
        headers[`Retry-After`] = String(result.error.retry_after)
      }
      res.writeHead(status, headers)
      res.end(JSON.stringify({ error: result.error }))
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(result))
  }

  private async handleAck(
    consumerId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Extract bearer token
    const authHeader = req.headers[`authorization`]
    if (!authHeader || !authHeader.startsWith(`Bearer `)) {
      res.writeHead(401, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `TOKEN_INVALID`,
            message: `Missing or malformed Authorization header`,
          },
        })
      )
      return
    }
    const token = authHeader.slice(`Bearer `.length)

    // Parse body
    const body = await this.readBody(req)
    let parsed: AckRequest
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
        })
      )
      return
    }

    if (!isValidAckRequest(parsed)) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `offsets must be an array of { path, offset } objects`,
          },
        })
      )
      return
    }

    const result = this.manager.ack(consumerId, token, parsed)

    if (`error` in result) {
      const status = ERROR_CODE_TO_STATUS[result.error.code] ?? 500
      res.writeHead(status, { "content-type": `application/json` })
      res.end(JSON.stringify({ error: result.error }))
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify({ ok: true, token: result.token }))
  }

  private handleRelease(
    consumerId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): void {
    const authHeader = req.headers[`authorization`]
    if (!authHeader || !authHeader.startsWith(`Bearer `)) {
      res.writeHead(401, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `TOKEN_INVALID`,
            message: `Missing or malformed Authorization header`,
          },
        })
      )
      return
    }
    const token = authHeader.slice(`Bearer `.length)

    const result = this.manager.release(consumerId, token)

    if (`error` in result) {
      const status = ERROR_CODE_TO_STATUS[result.error.code] ?? 500
      res.writeHead(status, { "content-type": `application/json` })
      res.end(JSON.stringify({ error: result.error }))
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(result))
  }

  private async handleSetWakePreference(
    consumerId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
        })
      )
      return
    }

    if (typeof parsed !== `object` || parsed === null) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
        })
      )
      return
    }

    const payload = parsed as {
      type?: unknown
      url?: unknown
      wake_stream?: unknown
    }

    const existingConsumer = this.manager.getConsumer(consumerId)
    if (!existingConsumer) {
      res.writeHead(404, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `CONSUMER_NOT_FOUND`,
            message: `Consumer not found`,
          },
        })
      )
      return
    }

    if (
      typeof payload.type !== `string` ||
      ![`none`, `webhook`, `pull-wake`].includes(payload.type)
    ) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `type must be one of: none, webhook, pull-wake`,
          },
        })
      )
      return
    }

    let preference: WakePreference
    if (payload.type === `none`) {
      preference = { type: `none` }
    } else if (payload.type === `webhook`) {
      if (!this.webhookManager) {
        res.writeHead(400, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `INVALID_REQUEST`,
              message: `webhook wake preference requires webhook support to be enabled`,
            },
          })
        )
        return
      }
      if (typeof payload.url !== `string` || payload.url.length === 0) {
        res.writeHead(400, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `INVALID_REQUEST`,
              message: `webhook type requires url field`,
            },
          })
        )
        return
      }
      preference = { type: `webhook`, url: payload.url }
    } else {
      // pull-wake
      if (
        typeof payload.wake_stream !== `string` ||
        payload.wake_stream.length === 0
      ) {
        res.writeHead(400, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `INVALID_REQUEST`,
              message: `pull-wake type requires wake_stream field`,
            },
          })
        )
        return
      }

      // Phase 2: reject pull-wake for multi-stream consumers
      if (existingConsumer.streams.length > 1) {
        res.writeHead(400, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `MULTI_STREAM_PULL_WAKE`,
              message: `pull-wake is not supported for multi-stream consumers`,
            },
          })
        )
        return
      }

      preference = { type: `pull-wake`, wake_stream: payload.wake_stream }
    }

    const previousPreference = existingConsumer.wake_preference
    const consumer = this.manager.setWakePreference(consumerId, preference)
    if (!consumer) {
      res.writeHead(404, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `CONSUMER_NOT_FOUND`,
            message: `Consumer not found`,
          },
        })
      )
      return
    }

    if (
      this.webhookManager &&
      previousPreference.type === `webhook` &&
      preference.type !== `webhook`
    ) {
      this.webhookManager.clearDirectWebhookPreference(consumerId)
    }

    if (this.pullWakeManager) {
      this.pullWakeManager.clearPendingWake(consumerId)
    }

    if (preference.type === `webhook`) {
      const configured = this.webhookManager?.setDirectWebhookPreference(
        consumerId,
        preference.url
      )
      if (!configured) {
        res.writeHead(404, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `CONSUMER_NOT_FOUND`,
              message: `Consumer not found`,
            },
          })
        )
        return
      }
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify({ ok: true, wake_preference: preference }))
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private readBody(req: IncomingMessage): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Array<Buffer> = []
      req.on(`data`, (chunk: Buffer) => chunks.push(chunk))
      req.on(`end`, () => resolve(new Uint8Array(Buffer.concat(chunks))))
      req.on(`error`, reject)
    })
  }
}

function isValidAckRequest(value: unknown): value is AckRequest {
  if (!value || typeof value !== `object`) return false
  const offsets = (value as { offsets?: unknown }).offsets
  if (!Array.isArray(offsets)) return false

  return offsets.every(
    (offset) =>
      !!offset &&
      typeof offset === `object` &&
      typeof (offset as { path?: unknown }).path === `string` &&
      typeof (offset as { offset?: unknown }).offset === `string`
  )
}

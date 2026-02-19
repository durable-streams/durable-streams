/**
 * HTTP handlers for webhook subscription CRUD and callback API.
 */

import type { WebhookManager } from "./webhook-manager"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { CallbackRequest, Subscription } from "./webhook-types"

const ERROR_CODE_TO_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  ALREADY_CLAIMED: 409,
  INVALID_OFFSET: 409,
  STALE_EPOCH: 409,
  CONSUMER_GONE: 410,
}

/**
 * Serialize a subscription for API responses, omitting internal fields.
 */
function serializeSubscription(sub: Subscription): Record<string, unknown> {
  return {
    subscription_id: sub.subscription_id,
    pattern: sub.pattern,
    webhook: sub.webhook,
    description: sub.description,
  }
}

/**
 * Handles webhook-related HTTP routes.
 */
export class WebhookRoutes {
  private manager: WebhookManager

  constructor(manager: WebhookManager) {
    this.manager = manager
  }

  /**
   * Try to handle a request as a webhook route.
   * Returns true if the request was handled, false if it should be passed through.
   */
  async handleRequest(
    method: string,
    url: URL,
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    // Check for callback routes: /callback/{consumer_id}
    if (path.startsWith(`/callback/`)) {
      await this.handleCallback(path, req, res)
      return true
    }

    // Check for subscription query parameters
    const hasSubscription = url.searchParams.has(`subscription`)
    const hasSubscriptions = url.searchParams.has(`subscriptions`)

    if (!hasSubscription && !hasSubscriptions) {
      return false
    }

    if (hasSubscription) {
      const subscriptionId = url.searchParams.get(`subscription`)!

      switch (method) {
        case `PUT`:
          await this.handleCreateSubscription(path, subscriptionId, req, res)
          return true
        case `GET`:
          this.handleGetSubscription(subscriptionId, res)
          return true
        case `DELETE`:
          this.handleDeleteSubscription(subscriptionId, res)
          return true
        default:
          res.writeHead(405, { "content-type": `text/plain` })
          res.end(`Method not allowed`)
          return true
      }
    }

    if (hasSubscriptions && method === `GET`) {
      this.handleListSubscriptions(path, res)
      return true
    }

    return false
  }

  // ============================================================================
  // Subscription CRUD
  // ============================================================================

  private async handleCreateSubscription(
    pattern: string,
    subscriptionId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let parsed: { webhook?: string; description?: string }

    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(`Invalid JSON body`)
      return
    }

    if (!parsed.webhook) {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(`Missing required field: webhook`)
      return
    }

    try {
      const { subscription, created } = this.manager.store.createSubscription(
        subscriptionId,
        pattern,
        parsed.webhook,
        parsed.description
      )

      const responseBody = serializeSubscription(subscription)
      if (created) {
        responseBody.webhook_secret = subscription.webhook_secret
      }

      res.writeHead(created ? 201 : 200, {
        "content-type": `application/json`,
      })
      res.end(JSON.stringify(responseBody))
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes(`different configuration`)
      ) {
        res.writeHead(409, { "content-type": `text/plain` })
        res.end(`Subscription already exists with different configuration`)
      } else {
        throw err
      }
    }
  }

  private handleGetSubscription(
    subscriptionId: string,
    res: ServerResponse
  ): void {
    const sub = this.manager.store.getSubscription(subscriptionId)
    if (!sub) {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end(`Subscription not found`)
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(serializeSubscription(sub)))
  }

  private handleDeleteSubscription(
    subscriptionId: string,
    res: ServerResponse
  ): void {
    this.manager.store.deleteSubscription(subscriptionId)
    res.writeHead(204)
    res.end()
  }

  private handleListSubscriptions(pattern: string, res: ServerResponse): void {
    const subs = this.manager.store.listSubscriptions(pattern)
    const sanitized = subs.map(serializeSubscription)

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify({ subscriptions: sanitized }))
  }

  // ============================================================================
  // Callback API
  // ============================================================================

  private async handleCallback(
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Extract consumer ID from /callback/{consumer_id}
    const consumerId = path.slice(`/callback/`.length)

    // Extract token from Authorization header
    const authHeader = req.headers[`authorization`]
    if (!authHeader || !authHeader.startsWith(`Bearer `)) {
      res.writeHead(401, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: `TOKEN_INVALID`,
            message: `Missing or malformed Authorization header`,
          },
        })
      )
      return
    }
    const token = authHeader.slice(`Bearer `.length)

    // Parse request body
    const body = await this.readBody(req)
    let parsed: Partial<CallbackRequest>
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: `INVALID_REQUEST`,
            message: `Invalid JSON body`,
          },
        })
      )
      return
    }

    // Validate epoch is present
    if (parsed.epoch === undefined) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: `INVALID_REQUEST`,
            message: `Missing required field: epoch`,
          },
        })
      )
      return
    }

    const request = parsed as CallbackRequest

    // Process callback
    const result = this.manager.handleCallback(consumerId, token, request)

    const status = result.ok
      ? 200
      : (ERROR_CODE_TO_STATUS[result.error.code] ?? 500)

    res.writeHead(status, { "content-type": `application/json` })
    res.end(JSON.stringify(result))
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

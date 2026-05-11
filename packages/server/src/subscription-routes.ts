import {
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  normalizeRelativePath,
} from "./subscription-manager"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { SubscriptionManager } from "./subscription-manager"
import type {
  SubscriptionCallbackRequest,
  SubscriptionCreateInput,
  SubscriptionErrorCode,
  SubscriptionType,
} from "./subscription-types"

interface ParsedRoute {
  serviceId: string
  subscriptionId: string
  action:
    | `base`
    | `streams`
    | `stream`
    | `callback`
    | `claim`
    | `ack`
    | `release`
  streamPath?: string
}

const ERROR_STATUS: Record<SubscriptionErrorCode, number> = {
  INVALID_REQUEST: 400,
  SUBSCRIPTION_NOT_FOUND: 404,
  SUBSCRIPTION_ALREADY_EXISTS: 409,
  WEBHOOK_URL_REJECTED: 400,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  FENCED: 409,
  ALREADY_CLAIMED: 409,
  NO_PENDING_WORK: 409,
  INVALID_OFFSET: 409,
}

export class SubscriptionRoutes {
  private readonly manager: SubscriptionManager

  constructor(manager: SubscriptionManager) {
    this.manager = manager
  }

  async handleRequest(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    const route = this.parseRoute(path)
    if (!route) return false

    try {
      switch (route.action) {
        case `base`:
          await this.handleBase(route, method, req, res)
          return true
        case `streams`:
          await this.handleStreams(route, method, req, res)
          return true
        case `stream`:
          this.handleStream(route, method, res)
          return true
        case `callback`:
          await this.handleCallback(route, req, res)
          return true
        case `claim`:
          await this.handleClaim(route, req, res)
          return true
        case `ack`:
          await this.handleAck(route, req, res)
          return true
        case `release`:
          await this.handleRelease(route, req, res)
          return true
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        this.writeError(res, 400, `INVALID_REQUEST`, `Invalid JSON body`)
        return true
      }
      throw err
    }
  }

  private async handleBase(
    route: ParsedRoute,
    method: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (method === `PUT`) {
      const parsed = await this.readJson(req)
      const input = this.parseCreateInput(parsed)
      if (`error` in input) {
        this.writeError(res, 400, `INVALID_REQUEST`, input.error)
        return
      }

      const result = this.manager.createOrConfirm(
        route.serviceId,
        route.subscriptionId,
        input.value
      )
      if (`error` in result) {
        this.writeError(
          res,
          ERROR_STATUS[result.error.code],
          result.error.code,
          result.error.message
        )
        return
      }

      this.writeJson(
        res,
        result.created ? 201 : 200,
        this.manager.serialize(result.subscription, result.created)
      )
      return
    }

    if (method === `GET`) {
      const subscription = this.manager.get(
        route.serviceId,
        route.subscriptionId
      )
      if (!subscription) {
        this.writeError(
          res,
          404,
          `SUBSCRIPTION_NOT_FOUND`,
          `Subscription not found`
        )
        return
      }
      this.writeJson(res, 200, this.manager.serialize(subscription, false))
      return
    }

    if (method === `DELETE`) {
      this.manager.delete(route.serviceId, route.subscriptionId)
      res.writeHead(204)
      res.end()
      return
    }

    this.methodNotAllowed(res)
  }

  private async handleStreams(
    route: ParsedRoute,
    method: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (method !== `POST`) {
      this.methodNotAllowed(res)
      return
    }
    const parsed = await this.readJson(req)
    const streams = (parsed as { streams?: unknown }).streams
    if (
      !Array.isArray(streams) ||
      streams.some(
        (stream) => typeof stream !== `string` || stream.length === 0
      )
    ) {
      this.writeError(
        res,
        400,
        `INVALID_REQUEST`,
        `streams must be a non-empty string array`
      )
      return
    }
    const ok = this.manager.addExplicitStreams(
      route.serviceId,
      route.subscriptionId,
      streams.map(normalizeRelativePath)
    )
    if (!ok) {
      this.writeError(
        res,
        404,
        `SUBSCRIPTION_NOT_FOUND`,
        `Subscription not found`
      )
      return
    }
    res.writeHead(204)
    res.end()
  }

  private handleStream(
    route: ParsedRoute,
    method: string,
    res: ServerResponse
  ): void {
    if (method !== `DELETE`) {
      this.methodNotAllowed(res)
      return
    }
    const ok = this.manager.removeExplicitStream(
      route.serviceId,
      route.subscriptionId,
      route.streamPath ?? ``
    )
    if (!ok) {
      this.writeError(
        res,
        404,
        `SUBSCRIPTION_NOT_FOUND`,
        `Subscription not found`
      )
      return
    }
    res.writeHead(204)
    res.end()
  }

  private async handleCallback(
    route: ParsedRoute,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const token = this.readBearerToken(req)
    if (!token) {
      this.writeError(
        res,
        401,
        `TOKEN_INVALID`,
        `Missing or malformed Authorization header`
      )
      return
    }
    const body = (await this.readJson(req)) as SubscriptionCallbackRequest
    const result = await this.manager.handleWebhookCallback(
      route.serviceId,
      route.subscriptionId,
      token,
      body
    )
    this.writeManagerResult(res, result)
  }

  private async handleClaim(
    route: ParsedRoute,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const parsed = await this.readJson(req)
    const worker = (parsed as { worker?: unknown }).worker
    if (typeof worker !== `string` || worker.length === 0) {
      this.writeError(
        res,
        400,
        `INVALID_REQUEST`,
        `worker must be a non-empty string`
      )
      return
    }
    const result = await this.manager.claim(
      route.serviceId,
      route.subscriptionId,
      worker
    )
    this.writeManagerResult(res, result)
  }

  private async handleAck(
    route: ParsedRoute,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const token = this.readBearerToken(req)
    if (!token) {
      this.writeError(
        res,
        401,
        `TOKEN_INVALID`,
        `Missing or malformed Authorization header`
      )
      return
    }
    const body = (await this.readJson(req)) as SubscriptionCallbackRequest
    const result = await this.manager.ack(
      route.serviceId,
      route.subscriptionId,
      token,
      body
    )
    this.writeManagerResult(res, result)
  }

  private async handleRelease(
    route: ParsedRoute,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const token = this.readBearerToken(req)
    if (!token) {
      this.writeError(
        res,
        401,
        `TOKEN_INVALID`,
        `Missing or malformed Authorization header`
      )
      return
    }
    const body = (await this.readJson(req)) as SubscriptionCallbackRequest
    const result = await this.manager.release(
      route.serviceId,
      route.subscriptionId,
      token,
      body
    )
    this.writeManagerResult(res, result)
  }

  private parseCreateInput(
    value: unknown
  ): { value: SubscriptionCreateInput } | { error: string } {
    if (!value || typeof value !== `object`) {
      return { error: `Request body must be a JSON object` }
    }
    const payload = value as Record<string, unknown>
    if (payload.type !== `webhook` && payload.type !== `pull-wake`) {
      return { error: `type must be "webhook" or "pull-wake"` }
    }
    const type = payload.type as SubscriptionType
    const pattern =
      typeof payload.pattern === `string` && payload.pattern.length > 0
        ? normalizeRelativePath(payload.pattern)
        : undefined
    const streams =
      Array.isArray(payload.streams) && payload.streams.length > 0
        ? payload.streams.map((stream) =>
            typeof stream === `string` ? normalizeRelativePath(stream) : null
          )
        : []
    if (streams.some((stream) => stream === null)) {
      return { error: `streams must contain only strings` }
    }
    if (!pattern && streams.length === 0) {
      return { error: `At least one of pattern or streams is required` }
    }

    const leaseTtl =
      payload.lease_ttl_ms === undefined
        ? DEFAULT_LEASE_TTL_MS
        : payload.lease_ttl_ms
    if (
      typeof leaseTtl !== `number` ||
      !Number.isInteger(leaseTtl) ||
      leaseTtl < MIN_LEASE_TTL_MS ||
      leaseTtl > MAX_LEASE_TTL_MS
    ) {
      return { error: `lease_ttl_ms must be an integer from 1000 to 600000` }
    }

    let webhook: { url: string } | undefined
    if (type === `webhook`) {
      const rawWebhook = payload.webhook
      if (!rawWebhook || typeof rawWebhook !== `object`) {
        return { error: `webhook subscriptions require webhook.url` }
      }
      const url = (rawWebhook as { url?: unknown }).url
      if (typeof url !== `string` || url.length === 0) {
        return { error: `webhook subscriptions require webhook.url` }
      }
      webhook = { url }
    }

    const wakeStream =
      typeof payload.wake_stream === `string` && payload.wake_stream.length > 0
        ? normalizeRelativePath(payload.wake_stream)
        : undefined
    if (type === `pull-wake` && !wakeStream) {
      return { error: `pull-wake subscriptions require wake_stream` }
    }

    return {
      value: {
        type,
        pattern,
        streams: streams as Array<string>,
        webhook,
        wake_stream: wakeStream,
        lease_ttl_ms: leaseTtl,
        description:
          typeof payload.description === `string`
            ? payload.description
            : undefined,
      },
    }
  }

  private parseRoute(path: string): ParsedRoute | null {
    const prefix = `/v1/stream/`
    if (!path.startsWith(prefix)) return null

    const rest = path.slice(prefix.length)
    const parts = rest.split(`/`)
    const serviceId = parts[0] ? decodeURIComponent(parts[0]) : ``
    if (!serviceId || parts[1] !== `__ds` || parts[2] !== `subscriptions`) {
      return null
    }

    const subscriptionId = parts[3] ? decodeURIComponent(parts[3]) : ``
    if (!subscriptionId) return null

    const tail = parts.slice(4)
    if (tail.length === 0) {
      return { serviceId, subscriptionId, action: `base` }
    }
    if (tail[0] === `streams` && tail.length === 1) {
      return { serviceId, subscriptionId, action: `streams` }
    }
    if (tail[0] === `streams` && tail.length > 1) {
      return {
        serviceId,
        subscriptionId,
        action: `stream`,
        streamPath: normalizeRelativePath(
          decodeURIComponent(tail.slice(1).join(`/`))
        ),
      }
    }
    if (
      tail.length === 1 &&
      [`callback`, `claim`, `ack`, `release`].includes(tail[0]!)
    ) {
      return {
        serviceId,
        subscriptionId,
        action: tail[0] as ParsedRoute[`action`],
      }
    }

    return null
  }

  private readBearerToken(req: IncomingMessage): string | null {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith(`Bearer `)) return null
    return authHeader.slice(`Bearer `.length)
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Array<Buffer> = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString(`utf8`)
    return raw.length > 0 ? JSON.parse(raw) : {}
  }

  private writeManagerResult(
    res: ServerResponse,
    result: { status: number; body?: Record<string, unknown> }
  ): void {
    if (result.status === 204) {
      res.writeHead(204)
      res.end()
      return
    }
    this.writeJson(res, result.status, result.body ?? {})
  }

  private writeJson(
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>
  ): void {
    res.writeHead(status, { "content-type": `application/json` })
    res.end(JSON.stringify(body))
  }

  private writeError(
    res: ServerResponse,
    status: number,
    code: SubscriptionErrorCode,
    message: string
  ): void {
    this.writeJson(res, status, { error: { code, message } })
  }

  private methodNotAllowed(res: ServerResponse): void {
    res.writeHead(405, { "content-type": `text/plain` })
    res.end(`Method not allowed`)
  }
}

import type { IncomingMessage, ServerResponse } from "node:http"

const SNAPSHOT_AVAILABLE_EVENT = `snapshot.available`

export interface SnapshotSubscriptionRoute {
  service: string
  subscriptionId: string
}

interface SnapshotSubscriptionInput {
  type: `webhook`
  events: Array<typeof SNAPSHOT_AVAILABLE_EVENT>
  documentPattern: string
  webhook: { url: string }
  leaseTtlMs?: number
  description?: string
}

export function parseSnapshotSubscriptionRoute(
  path: string
): SnapshotSubscriptionRoute | null {
  const match = path.match(/^\/v1\/yjs\/([^/]+)\/__ds\/subscriptions\/([^/]+)$/)
  if (!match) return null

  try {
    const service = match[1]!
    const subscriptionId = decodeURIComponent(match[2]!)
    if (
      service.length === 0 ||
      service.length > 256 ||
      service === `.` ||
      service === `..` ||
      !/^[a-zA-Z0-9_.-]+$/.test(service)
    ) {
      return null
    }
    if (
      subscriptionId.length === 0 ||
      subscriptionId.length > 256 ||
      subscriptionId.includes(`/`)
    ) {
      return null
    }
    return { service, subscriptionId }
  } catch {
    return null
  }
}

export class SnapshotSubscriptionHandler {
  private readonly dsServerUrl: string
  private readonly dsServerHeaders: Record<string, string>

  constructor(options: {
    dsServerUrl: string
    dsServerHeaders: Record<string, string>
  }) {
    this.dsServerUrl = options.dsServerUrl
    this.dsServerHeaders = options.dsServerHeaders
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    route: SnapshotSubscriptionRoute
  ): Promise<void> {
    const method = req.method?.toUpperCase()
    if (method === `PUT`) {
      await this.createOrConfirm(req, res, route)
      return
    }
    if (method === `GET`) {
      await this.read(req, res, route)
      return
    }
    if (method === `DELETE`) {
      await this.delete(req, res, route)
      return
    }

    this.writeError(res, 405, `INVALID_REQUEST`, `Method not allowed`)
  }

  private async createOrConfirm(
    req: IncomingMessage,
    res: ServerResponse,
    route: SnapshotSubscriptionRoute
  ): Promise<void> {
    let body: unknown
    try {
      body = JSON.parse((await this.readBody(req)).toString(`utf8`))
    } catch {
      this.writeError(res, 400, `INVALID_REQUEST`, `Invalid JSON body`)
      return
    }

    const parsed = this.parseInput(body)
    if (`error` in parsed) {
      this.writeError(res, 400, `INVALID_REQUEST`, parsed.error)
      return
    }

    const input = parsed.value
    const response = await this.requestSubscription(res, route, {
      method: `PUT`,
      headers: this.requestHeaders(req, true),
      body: JSON.stringify({
        type: input.type,
        pattern: this.indexPattern(route.service, input.documentPattern),
        webhook: input.webhook,
        lease_ttl_ms: input.leaseTtlMs,
        description: input.description,
      }),
    })
    if (!response) return

    await this.forwardResponse(res, response, route)
  }

  private async read(
    req: IncomingMessage,
    res: ServerResponse,
    route: SnapshotSubscriptionRoute
  ): Promise<void> {
    const response = await this.requestSubscription(res, route, {
      method: `GET`,
      headers: this.requestHeaders(req),
    })
    if (!response) return
    await this.forwardResponse(res, response, route)
  }

  private async delete(
    req: IncomingMessage,
    res: ServerResponse,
    route: SnapshotSubscriptionRoute
  ): Promise<void> {
    const response = await this.requestSubscription(res, route, {
      method: `DELETE`,
      headers: this.requestHeaders(req),
    })
    if (!response) return
    await this.forwardResponse(res, response, route)
  }

  private parseInput(
    body: unknown
  ): { value: SnapshotSubscriptionInput } | { error: string } {
    if (!body || typeof body !== `object`) {
      return { error: `Request body must be a JSON object` }
    }

    const input = body as Record<string, unknown>
    if (input.type !== `webhook`) {
      return { error: `type must be webhook` }
    }
    if (
      !Array.isArray(input.events) ||
      input.events.length !== 1 ||
      input.events[0] !== SNAPSHOT_AVAILABLE_EVENT
    ) {
      return { error: `events must contain only snapshot.available` }
    }

    const documentPattern = this.normalizeDocumentPattern(
      input.document_pattern
    )
    if (!documentPattern) {
      return { error: `document_pattern must be a valid document glob` }
    }

    const webhook = input.webhook
    if (!webhook || typeof webhook !== `object`) {
      return { error: `webhook subscriptions require webhook.url` }
    }
    const webhookUrl = (webhook as Record<string, unknown>).url
    if (typeof webhookUrl !== `string` || webhookUrl.length === 0) {
      return { error: `webhook subscriptions require webhook.url` }
    }

    if (
      input.lease_ttl_ms !== undefined &&
      (typeof input.lease_ttl_ms !== `number` ||
        !Number.isInteger(input.lease_ttl_ms))
    ) {
      return { error: `lease_ttl_ms must be an integer` }
    }
    if (
      input.description !== undefined &&
      typeof input.description !== `string`
    ) {
      return { error: `description must be a string` }
    }

    return {
      value: {
        type: `webhook`,
        events: [SNAPSHOT_AVAILABLE_EVENT],
        documentPattern,
        webhook: { url: webhookUrl },
        leaseTtlMs: input.lease_ttl_ms,
        description: input.description,
      },
    }
  }

  private normalizeDocumentPattern(value: unknown): string | null {
    if (typeof value !== `string`) return null
    const normalized = value.replace(/^\/+|\/+$/g, ``)
    if (normalized.length === 0 || normalized.length > 256) return null

    const segments = normalized.split(`/`)
    for (const segment of segments) {
      if (segment === `*` || segment === `**`) continue
      if (!/^[a-zA-Z0-9_-]+$/.test(segment)) return null
    }
    return normalized
  }

  private indexPattern(service: string, documentPattern: string): string {
    return `yjs/${service}/docs/${documentPattern}/.index`
  }

  private subscriptionUrl(route: SnapshotSubscriptionRoute): string {
    const deliveryId = this.deliverySubscriptionId(route)
    return `${this.dsServerUrl}/v1/stream/__ds/subscriptions/${encodeURIComponent(deliveryId)}`
  }

  private deliverySubscriptionId(route: SnapshotSubscriptionRoute): string {
    const service = Buffer.from(route.service).toString(`base64url`)
    const id = Buffer.from(route.subscriptionId).toString(`base64url`)
    return `yjs:${service}:${id}`
  }

  private requestHeaders(
    req: IncomingMessage,
    jsonBody: boolean = false
  ): globalThis.Headers {
    const excludedHeaders = new Set([
      `connection`,
      `content-length`,
      `host`,
      `keep-alive`,
      `proxy-authenticate`,
      `proxy-authorization`,
      `proxy-connection`,
      `te`,
      `trailer`,
      `transfer-encoding`,
      `upgrade`,
    ])
    const connection = req.headers.connection
    const connectionValues = Array.isArray(connection)
      ? connection
      : connection === undefined
        ? []
        : [connection]
    for (const value of connectionValues) {
      for (const name of value.split(`,`)) {
        const normalized = name.trim().toLowerCase()
        if (normalized) excludedHeaders.add(normalized)
      }
    }

    const headers = new globalThis.Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (!excludedHeaders.has(key.toLowerCase()) && value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(`, `) : value)
      }
    }
    for (const [key, value] of Object.entries(this.dsServerHeaders)) {
      headers.set(key, value)
    }
    if (jsonBody) headers.set(`content-type`, `application/json`)
    return headers
  }

  private async requestSubscription(
    res: ServerResponse,
    route: SnapshotSubscriptionRoute,
    init: globalThis.RequestInit
  ): Promise<globalThis.Response | null> {
    try {
      return await fetch(this.subscriptionUrl(route), init)
    } catch {
      this.writeError(
        res,
        502,
        `PROXY_ERROR`,
        `Failed to reach Durable Streams server`
      )
      return null
    }
  }

  private async forwardResponse(
    res: ServerResponse,
    response: globalThis.Response,
    route: SnapshotSubscriptionRoute
  ): Promise<void> {
    if (response.status === 204) {
      await response.arrayBuffer()
      res.writeHead(204)
      res.end()
      return
    }

    const contentType = response.headers.get(`content-type`)
    if (!response.ok || !contentType?.includes(`application/json`)) {
      const body = new Uint8Array(await response.arrayBuffer())
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (key !== `content-length` && key !== `content-encoding`) {
          headers[key] = value
        }
      })
      res.writeHead(response.status, headers)
      res.end(body)
      return
    }

    const subscription = (await response.json()) as Record<string, unknown>
    const deliverySubscriptionId =
      typeof subscription.subscription_id === `string`
        ? subscription.subscription_id
        : this.deliverySubscriptionId(route)
    const documentPattern = this.documentPatternFromSubscription(
      subscription,
      route.service
    )
    delete subscription.pattern

    res.writeHead(response.status, { "content-type": `application/json` })
    res.end(
      JSON.stringify({
        ...subscription,
        id: route.subscriptionId,
        subscription_id: route.subscriptionId,
        delivery_subscription_id: deliverySubscriptionId,
        service: route.service,
        events: [SNAPSHOT_AVAILABLE_EVENT],
        ...(documentPattern === undefined
          ? {}
          : { document_pattern: documentPattern }),
      })
    )
  }

  private documentPatternFromSubscription(
    subscription: Record<string, unknown>,
    service: string
  ): string | undefined {
    const pattern = subscription.pattern
    if (typeof pattern !== `string`) return undefined
    const prefix = `yjs/${service}/docs/`
    const suffix = `/.index`
    if (!pattern.startsWith(prefix) || !pattern.endsWith(suffix)) {
      return undefined
    }
    const documentPattern = pattern.slice(prefix.length, -suffix.length)
    return documentPattern.length > 0 ? documentPattern : undefined
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Array<Buffer> = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  private writeError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string
  ): void {
    res.writeHead(status, { "content-type": `application/json` })
    res.end(JSON.stringify({ error: { code, message } }))
  }
}

import { createHash } from "node:crypto"
import { isIP } from "node:net"
import {
  generateCallbackToken,
  generateWakeId,
  generateWebhookSecret,
  signWebhookPayload,
  validateCallbackToken,
} from "./crypto"
import { globMatch } from "./glob"
import { serverLog } from "./log"
import type {
  SubscriptionCallbackRequest,
  SubscriptionCreateInput,
  SubscriptionError,
  SubscriptionRecord,
  SubscriptionStreamInfo,
  SubscriptionStreamLink,
} from "./subscription-types"

const DEFAULT_LEASE_TTL_MS = 30_000
const MIN_LEASE_TTL_MS = 1_000
const MAX_LEASE_TTL_MS = 10 * 60_000
const ZERO_OFFSET = `0000000000000000_0000000000000000`
const BEFORE_FIRST_OFFSET = `-1`
const MAX_RETRY_DELAY_MS = 60_000

interface StreamLike {
  currentOffset: string
  softDeleted?: boolean
}

interface SubscriptionStreamStore {
  has: (path: string) => boolean
  get: (path: string) => StreamLike | undefined
  list: () => Array<string>
  append: (path: string, data: Uint8Array) => unknown
}

function compareOffsets(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function normalizeRelativePath(path: string): string {
  return path.replace(/^\/+/, ``).replace(/\/+$/, ``)
}

function toAbsoluteStreamPath(serviceId: string, streamPath: string): string {
  return `/v1/stream/${serviceId}/${normalizeRelativePath(streamPath)}`
}

function toServiceRelativePath(
  serviceId: string,
  absolutePath: string
): string | null {
  const prefix = `/v1/stream/${serviceId}/`
  if (!absolutePath.startsWith(prefix)) return null
  const relative = absolutePath.slice(prefix.length)
  if (relative === `` || relative.startsWith(`__ds/`)) return null
  return relative
}

function stableConfigHash(input: SubscriptionCreateInput): string {
  const canonical = {
    type: input.type,
    pattern: input.pattern,
    streams: [...new Set(input.streams)].sort(),
    webhook: input.webhook ? { url: input.webhook.url } : undefined,
    wake_stream: input.wake_stream,
    lease_ttl_ms: input.lease_ttl_ms,
    description: input.description,
  }
  return createHash(`sha256`).update(JSON.stringify(canonical)).digest(`hex`)
}

function isPrivateOrLinkLocalIpv4(host: string): boolean {
  const parts = host.split(`.`).map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false
  }
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

function isLocalDevHost(host: string): boolean {
  return host === `localhost` || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

export function validateWebhookUrl(
  rawUrl: string
): { ok: true } | { ok: false; message: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, message: `webhook.url must be a valid URL` }
  }

  const host = url.hostname.toLowerCase()
  if (url.protocol === `http:`) {
    if (isLocalDevHost(host)) return { ok: true }
    return {
      ok: false,
      message: `http webhook URLs are only allowed for localhost or 127.0.0.x`,
    }
  }

  if (url.protocol !== `https:`) {
    return { ok: false, message: `webhook.url must use https` }
  }

  if (host === `localhost`) {
    return {
      ok: false,
      message: `localhost webhook URLs must use http for dev`,
    }
  }

  if (isIP(host) === 4 && isPrivateOrLinkLocalIpv4(host)) {
    return {
      ok: false,
      message: `webhook.url must not target private or link-local hosts`,
    }
  }

  if (isIP(host) === 6) {
    return {
      ok: false,
      message: `IPv6 webhook hosts are not accepted by the reference server`,
    }
  }

  return { ok: true }
}

export class SubscriptionManager {
  private readonly subscriptions = new Map<string, SubscriptionRecord>()
  private readonly streamStore: SubscriptionStreamStore
  private readonly callbackBaseUrl: string
  private readonly webhooksEnabled: boolean
  private isShuttingDown = false

  constructor(opts: {
    callbackBaseUrl: string
    streamStore: SubscriptionStreamStore
    webhooksEnabled?: boolean
  }) {
    this.callbackBaseUrl = opts.callbackBaseUrl
    this.streamStore = opts.streamStore
    this.webhooksEnabled = opts.webhooksEnabled ?? true
  }

  createOrConfirm(
    serviceId: string,
    id: string,
    input: SubscriptionCreateInput
  ):
    | { subscription: SubscriptionRecord; created: boolean }
    | { error: SubscriptionError } {
    const configHash = stableConfigHash(input)
    const key = this.key(serviceId, id)
    const existing = this.subscriptions.get(key)
    if (existing) {
      if (existing.config_hash !== configHash) {
        return {
          error: {
            code: `SUBSCRIPTION_ALREADY_EXISTS`,
            message: `Subscription already exists with different configuration`,
          },
        }
      }
      return { subscription: existing, created: false }
    }

    if (input.type === `webhook`) {
      if (!this.webhooksEnabled) {
        return {
          error: {
            code: `INVALID_REQUEST`,
            message: `webhook subscriptions are not enabled on this server`,
          },
        }
      }
      if (!input.webhook) {
        return {
          error: {
            code: `INVALID_REQUEST`,
            message: `webhook subscriptions require webhook.url`,
          },
        }
      }
      const validation = validateWebhookUrl(input.webhook.url)
      if (!validation.ok) {
        return {
          error: { code: `WEBHOOK_URL_REJECTED`, message: validation.message },
        }
      }
    }

    if (input.type === `pull-wake` && !input.wake_stream) {
      return {
        error: {
          code: `INVALID_REQUEST`,
          message: `pull-wake subscriptions require wake_stream`,
        },
      }
    }

    const subscription: SubscriptionRecord = {
      service_id: serviceId,
      id,
      type: input.type,
      pattern: input.pattern,
      webhook: input.webhook
        ? { url: input.webhook.url, secret: generateWebhookSecret() }
        : undefined,
      wake_stream: input.wake_stream,
      lease_ttl_ms: input.lease_ttl_ms,
      description: input.description,
      created_at: new Date().toISOString(),
      status: `active`,
      config_hash: configHash,
      streams: new Map(),
      generation: 0,
      wake_id: null,
      wake_snapshot: new Map(),
      token: null,
      holder: null,
      lease_timer: null,
      retry_count: 0,
      retry_timer: null,
      next_attempt_at: null,
    }

    for (const stream of input.streams) {
      this.linkStream(
        subscription,
        stream,
        `explicit`,
        this.getTailOffset(serviceId, stream)
      )
    }

    if (input.pattern) {
      for (const stream of this.listServiceStreams(serviceId)) {
        if (globMatch(input.pattern, stream)) {
          this.linkStream(
            subscription,
            stream,
            `glob`,
            this.getTailOffset(serviceId, stream)
          )
        }
      }
    }

    this.subscriptions.set(key, subscription)
    return { subscription, created: true }
  }

  get(serviceId: string, id: string): SubscriptionRecord | undefined {
    return this.subscriptions.get(this.key(serviceId, id))
  }

  delete(serviceId: string, id: string): boolean {
    const key = this.key(serviceId, id)
    const subscription = this.subscriptions.get(key)
    if (!subscription) return false
    this.clearLease(subscription)
    if (subscription.retry_timer) clearTimeout(subscription.retry_timer)
    this.subscriptions.delete(key)
    return true
  }

  addExplicitStreams(
    serviceId: string,
    id: string,
    streams: Array<string>
  ): boolean {
    const subscription = this.get(serviceId, id)
    if (!subscription) return false
    for (const stream of streams) {
      this.linkStream(
        subscription,
        stream,
        `explicit`,
        this.getTailOffset(serviceId, stream)
      )
    }
    return true
  }

  removeExplicitStream(
    serviceId: string,
    id: string,
    streamPath: string
  ): boolean {
    const subscription = this.get(serviceId, id)
    if (!subscription) return false
    const normalized = normalizeRelativePath(streamPath)
    const link = subscription.streams.get(normalized)
    if (!link) return true
    link.link_types.delete(`explicit`)
    if (link.link_types.size === 0) {
      subscription.streams.delete(normalized)
    }
    return true
  }

  async onStreamAppend(absolutePath: string): Promise<void> {
    if (this.isShuttingDown) return
    for (const subscription of this.subscriptions.values()) {
      const relative = toServiceRelativePath(
        subscription.service_id,
        absolutePath
      )
      if (!relative) continue
      if (subscription.pattern && globMatch(subscription.pattern, relative)) {
        const existing = subscription.streams.get(relative)
        this.linkStream(
          subscription,
          relative,
          `glob`,
          existing?.acked_offset ?? BEFORE_FIRST_OFFSET
        )
      }
      if (subscription.streams.has(relative)) {
        await this.maybeWake(subscription, relative)
      }
    }
  }

  onStreamDeleted(absolutePath: string): void {
    for (const subscription of this.subscriptions.values()) {
      const relative = toServiceRelativePath(
        subscription.service_id,
        absolutePath
      )
      if (relative) subscription.streams.delete(relative)
    }
  }

  async handleWebhookCallback(
    serviceId: string,
    id: string,
    token: string,
    request: SubscriptionCallbackRequest
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const subscription = this.get(serviceId, id)
    if (!subscription) {
      return this.errorResponse(
        404,
        `SUBSCRIPTION_NOT_FOUND`,
        `Subscription not found`
      )
    }
    const fenced = this.validateWakeToken(subscription, token, request)
    if (fenced) return fenced

    const ackError = this.applyAcks(subscription, request)
    if (ackError) return ackError

    this.extendLease(subscription)
    let nextWake = false
    if (request.done === true) {
      this.clearLease(subscription)
      subscription.token = null
      subscription.holder = null
      subscription.wake_id = null
      subscription.wake_snapshot.clear()
      nextWake = await this.triggerNextWakeIfPending(subscription)
    }

    return { status: 200, body: { ok: true, next_wake: nextWake } }
  }

  async claim(
    serviceId: string,
    id: string,
    worker: string
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const subscription = this.get(serviceId, id)
    if (!subscription) {
      return this.errorResponse(
        404,
        `SUBSCRIPTION_NOT_FOUND`,
        `Subscription not found`
      )
    }
    if (subscription.type !== `pull-wake`) {
      return this.errorResponse(
        400,
        `INVALID_REQUEST`,
        `Subscription is not pull-wake`
      )
    }
    if (subscription.holder) {
      return {
        status: 409,
        body: {
          error: {
            code: `ALREADY_CLAIMED`,
            current_holder: subscription.holder,
            generation: subscription.generation,
          },
        },
      }
    }
    if (!this.hasPendingWork(subscription)) {
      return this.errorResponse(
        409,
        `NO_PENDING_WORK`,
        `Subscription has no pending work`
      )
    }
    if (!subscription.wake_id) {
      await this.createWake(subscription, this.firstPendingStream(subscription))
    }

    subscription.holder = worker
    subscription.token = generateCallbackToken(
      this.tokenSubject(subscription),
      subscription.generation
    )
    this.extendLease(subscription)

    return {
      status: 200,
      body: {
        wake_id: subscription.wake_id,
        generation: subscription.generation,
        token: subscription.token,
        streams: this.streamInfos(subscription),
        lease_ttl_ms: subscription.lease_ttl_ms,
      },
    }
  }

  async ack(
    serviceId: string,
    id: string,
    token: string,
    request: SubscriptionCallbackRequest
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const subscription = this.get(serviceId, id)
    if (!subscription) {
      return this.errorResponse(
        404,
        `SUBSCRIPTION_NOT_FOUND`,
        `Subscription not found`
      )
    }
    if (subscription.type !== `pull-wake`) {
      return this.errorResponse(
        400,
        `INVALID_REQUEST`,
        `Subscription is not pull-wake`
      )
    }
    const fenced = this.validateWakeToken(subscription, token, request)
    if (fenced) return fenced

    const ackError = this.applyAcks(subscription, request)
    if (ackError) return ackError

    this.extendLease(subscription)
    let nextWake = false
    if (request.done === true) {
      this.clearLease(subscription)
      subscription.token = null
      subscription.holder = null
      subscription.wake_id = null
      subscription.wake_snapshot.clear()
      nextWake = await this.triggerNextWakeIfPending(subscription)
    }
    return { status: 200, body: { ok: true, next_wake: nextWake } }
  }

  async release(
    serviceId: string,
    id: string,
    token: string,
    request: SubscriptionCallbackRequest
  ): Promise<{ status: number; body?: Record<string, unknown> }> {
    const subscription = this.get(serviceId, id)
    if (!subscription) {
      return this.errorResponse(
        404,
        `SUBSCRIPTION_NOT_FOUND`,
        `Subscription not found`
      )
    }
    if (subscription.type !== `pull-wake`) {
      return this.errorResponse(
        400,
        `INVALID_REQUEST`,
        `Subscription is not pull-wake`
      )
    }
    const fenced = this.validateWakeToken(subscription, token, request)
    if (fenced) return fenced

    this.clearLease(subscription)
    subscription.token = null
    subscription.holder = null
    subscription.wake_id = null
    subscription.wake_snapshot.clear()
    await this.triggerNextWakeIfPending(subscription)
    return { status: 204 }
  }

  serialize(
    subscription: SubscriptionRecord,
    includeSecret: boolean
  ): Record<string, unknown> {
    return {
      id: subscription.id,
      subscription_id: subscription.id,
      service_id: subscription.service_id,
      type: subscription.type,
      pattern: subscription.pattern,
      streams: this.streamInfos(subscription).map((stream) => ({
        path: stream.path,
        link_type: stream.link_type,
        acked_offset: stream.acked_offset,
      })),
      webhook: subscription.webhook
        ? {
            url: subscription.webhook.url,
            ...(includeSecret
              ? { webhook_secret: subscription.webhook.secret }
              : {}),
          }
        : undefined,
      ...(includeSecret && subscription.webhook
        ? { webhook_secret: subscription.webhook.secret }
        : {}),
      wake_stream: subscription.wake_stream,
      lease_ttl_ms: subscription.lease_ttl_ms,
      created_at: subscription.created_at,
      status: subscription.status,
      description: subscription.description,
    }
  }

  shutdown(): void {
    this.isShuttingDown = true
    for (const subscription of this.subscriptions.values()) {
      this.clearLease(subscription)
      if (subscription.retry_timer) clearTimeout(subscription.retry_timer)
    }
    this.subscriptions.clear()
  }

  private async maybeWake(
    subscription: SubscriptionRecord,
    triggeredBy: string
  ): Promise<void> {
    if (subscription.wake_id || subscription.holder) return
    if (!this.hasPendingWork(subscription)) return
    await this.createWake(subscription, triggeredBy)
  }

  private async createWake(
    subscription: SubscriptionRecord,
    triggeredBy: string
  ): Promise<void> {
    subscription.generation++
    subscription.wake_id = generateWakeId()
    subscription.wake_snapshot = new Map(
      this.streamInfos(subscription).map((stream) => [
        stream.path,
        stream.tail_offset,
      ])
    )

    if (subscription.type === `webhook`) {
      subscription.token = generateCallbackToken(
        this.tokenSubject(subscription),
        subscription.generation
      )
      this.extendLease(subscription)
      void this.deliverWebhook(subscription, [triggeredBy])
      return
    }

    await this.writePullWakeEvent(subscription, triggeredBy)
  }

  private async deliverWebhook(
    subscription: SubscriptionRecord,
    triggeredBy: Array<string>
  ): Promise<void> {
    if (!subscription.webhook || !subscription.wake_id || !subscription.token)
      return

    const body = JSON.stringify({
      subscription_id: subscription.id,
      wake_id: subscription.wake_id,
      generation: subscription.generation,
      streams: this.streamInfos(subscription),
      callback_url: `${this.callbackBaseUrl}/v1/stream/${subscription.service_id}/__ds/subscriptions/${encodeURIComponent(subscription.id)}/callback`,
      callback_token: subscription.token,
    })

    const headers = {
      "content-type": `application/json`,
      "webhook-signature": signWebhookPayload(
        body,
        subscription.webhook.secret
      ),
    }

    try {
      const response = await fetch(subscription.webhook.url, {
        method: `POST`,
        headers,
        body,
      })
      if (!response.ok) {
        this.scheduleWebhookRetry(subscription, triggeredBy)
        return
      }

      subscription.status = `active`
      subscription.retry_count = 0
      subscription.next_attempt_at = null

      let parsed: { done?: boolean } | null = null
      try {
        parsed = (await response.json()) as { done?: boolean }
      } catch {
        parsed = null
      }

      if (parsed?.done === true) {
        this.autoAckWakeSnapshot(subscription)
        this.clearLease(subscription)
        subscription.token = null
        subscription.holder = null
        subscription.wake_id = null
        subscription.wake_snapshot.clear()
        await this.triggerNextWakeIfPending(subscription)
      }
    } catch (err) {
      serverLog.warn(`[subscriptions] webhook delivery failed:`, err)
      this.scheduleWebhookRetry(subscription, triggeredBy)
    }
  }

  private scheduleWebhookRetry(
    subscription: SubscriptionRecord,
    triggeredBy: Array<string>
  ): void {
    if (this.isShuttingDown) return
    subscription.retry_count++
    const baseDelay = Math.min(
      1000 * Math.pow(2, Math.max(0, subscription.retry_count - 1)),
      MAX_RETRY_DELAY_MS
    )
    const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1)
    const delay = Math.max(0, Math.round(baseDelay + jitter))
    subscription.status = `failed`
    subscription.next_attempt_at = Date.now() + delay
    if (subscription.retry_timer) clearTimeout(subscription.retry_timer)
    subscription.retry_timer = setTimeout(() => {
      subscription.retry_timer = null
      void this.deliverWebhook(subscription, triggeredBy)
    }, delay)
  }

  private async writePullWakeEvent(
    subscription: SubscriptionRecord,
    streamPath: string
  ): Promise<void> {
    if (!subscription.wake_stream) return
    const wakeStream = toAbsoluteStreamPath(
      subscription.service_id,
      subscription.wake_stream
    )
    if (!this.streamStore.has(wakeStream)) {
      serverLog.warn(
        `[subscriptions] wake stream does not exist: ${wakeStream}`
      )
      return
    }
    const event = {
      type: `wake`,
      subscription_id: subscription.id,
      stream: streamPath,
      generation: subscription.generation,
      ts: Date.now(),
    }
    await Promise.resolve(
      this.streamStore.append(
        wakeStream,
        new TextEncoder().encode(JSON.stringify(event))
      )
    )
  }

  private autoAckWakeSnapshot(subscription: SubscriptionRecord): void {
    for (const [stream, tail] of subscription.wake_snapshot) {
      const link = subscription.streams.get(stream)
      if (link) link.acked_offset = tail
    }
  }

  private applyAcks(
    subscription: SubscriptionRecord,
    request: SubscriptionCallbackRequest
  ): { status: number; body: Record<string, unknown> } | null {
    if (!request.acks) return null
    for (const ack of request.acks) {
      const stream = normalizeRelativePath(ack.stream ?? ack.path ?? ``)
      const link = subscription.streams.get(stream)
      if (!stream || !link) {
        return this.errorResponse(
          409,
          `INVALID_OFFSET`,
          `Ack references an unknown subscription stream`
        )
      }
      if (ack.offset === BEFORE_FIRST_OFFSET) {
        return this.errorResponse(
          409,
          `INVALID_OFFSET`,
          `Ack offset must not be -1`
        )
      }
      if (compareOffsets(ack.offset, link.acked_offset) < 0) {
        return this.errorResponse(
          409,
          `INVALID_OFFSET`,
          `Ack offset regresses the committed cursor`
        )
      }
      if (
        compareOffsets(
          ack.offset,
          this.getTailOffset(subscription.service_id, stream)
        ) > 0
      ) {
        return this.errorResponse(
          409,
          `INVALID_OFFSET`,
          `Ack offset is beyond stream tail`
        )
      }
    }
    for (const ack of request.acks) {
      const stream = normalizeRelativePath(ack.stream ?? ack.path ?? ``)
      subscription.streams.get(stream)!.acked_offset = ack.offset
    }
    return null
  }

  private validateWakeToken(
    subscription: SubscriptionRecord,
    token: string,
    request: SubscriptionCallbackRequest
  ): { status: number; body: Record<string, unknown> } | null {
    const tokenResult = validateCallbackToken(
      token,
      this.tokenSubject(subscription)
    )
    if (!tokenResult.valid) {
      return this.errorResponse(
        401,
        tokenResult.code,
        tokenResult.code === `TOKEN_EXPIRED` ? `Token expired` : `Token invalid`
      )
    }
    if (
      tokenResult.epoch !== subscription.generation ||
      request.generation !== subscription.generation ||
      request.wake_id !== subscription.wake_id
    ) {
      return this.errorResponse(409, `FENCED`, `Wake generation is stale`)
    }
    return null
  }

  private async triggerNextWakeIfPending(
    subscription: SubscriptionRecord
  ): Promise<boolean> {
    if (!this.hasPendingWork(subscription)) return false
    await this.createWake(subscription, this.firstPendingStream(subscription))
    return true
  }

  private hasPendingWork(subscription: SubscriptionRecord): boolean {
    return this.streamInfos(subscription).some((stream) => stream.has_pending)
  }

  private firstPendingStream(subscription: SubscriptionRecord): string {
    return (
      this.streamInfos(subscription).find((stream) => stream.has_pending)
        ?.path ?? ``
    )
  }

  private streamInfos(
    subscription: SubscriptionRecord
  ): Array<SubscriptionStreamInfo> {
    return Array.from(subscription.streams.values()).map((link) => {
      const tail = this.getTailOffset(subscription.service_id, link.path)
      return {
        path: link.path,
        link_type: link.link_types.has(`explicit`) ? `explicit` : `glob`,
        acked_offset: link.acked_offset,
        tail_offset: tail,
        has_pending: compareOffsets(tail, link.acked_offset) > 0,
      }
    })
  }

  private linkStream(
    subscription: SubscriptionRecord,
    streamPath: string,
    linkType: `glob` | `explicit`,
    ackedOffset: string
  ): SubscriptionStreamLink {
    const normalized = normalizeRelativePath(streamPath)
    const existing = subscription.streams.get(normalized)
    if (existing) {
      existing.link_types.add(linkType)
      return existing
    }
    const link: SubscriptionStreamLink = {
      path: normalized,
      link_types: new Set([linkType]),
      acked_offset: ackedOffset,
    }
    subscription.streams.set(normalized, link)
    return link
  }

  private listServiceStreams(serviceId: string): Array<string> {
    return this.streamStore
      .list()
      .map((path) => toServiceRelativePath(serviceId, path))
      .filter((path): path is string => path !== null)
  }

  private getTailOffset(serviceId: string, streamPath: string): string {
    return (
      this.streamStore.get(toAbsoluteStreamPath(serviceId, streamPath))
        ?.currentOffset ?? ZERO_OFFSET
    )
  }

  private extendLease(subscription: SubscriptionRecord): void {
    this.clearLease(subscription)
    subscription.lease_timer = setTimeout(() => {
      subscription.lease_timer = null
      subscription.holder = null
      subscription.token = null
      subscription.wake_id = null
      subscription.wake_snapshot.clear()
      void this.triggerNextWakeIfPending(subscription)
    }, subscription.lease_ttl_ms)
  }

  private clearLease(subscription: SubscriptionRecord): void {
    if (subscription.lease_timer) {
      clearTimeout(subscription.lease_timer)
      subscription.lease_timer = null
    }
  }

  private tokenSubject(subscription: SubscriptionRecord): string {
    return `${subscription.service_id}:${subscription.id}`
  }

  private key(serviceId: string, id: string): string {
    return `${serviceId}:${id}`
  }

  private errorResponse(
    status: number,
    code: SubscriptionError[`code`],
    message: string
  ): { status: number; body: Record<string, unknown> } {
    return { status, body: { error: { code, message } } }
  }
}

export {
  DEFAULT_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  normalizeRelativePath,
}

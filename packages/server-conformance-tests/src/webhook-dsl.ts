/**
 * Webhook Testing DSL — fluent builder, history recorder, and invariant checkers.
 *
 * Usage:
 *   await webhook(baseUrl)
 *     .subscription('/agents/*', 'my-sub')
 *     .stream('/agents/task-1')
 *     .append({ event: 'created' })
 *     .expectWake()
 *     .claimWake()
 *     .ackAll()
 *     .done()
 *     .expectIdle()
 *     .run()
 */

import { createServer as createHttpServer } from "node:http"
import { createHmac } from "node:crypto"
import { expect } from "vitest"
import { STREAM_OFFSET_HEADER } from "@durable-streams/client"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

// ============================================================================
// History Event Types
// ============================================================================

export type HistoryEvent =
  | {
      type: `subscription_created`
      id: string
      pattern: string
      webhookSecret: string
    }
  | { type: `stream_created`; path: string }
  | { type: `stream_deleted`; path: string }
  | {
      type: `events_appended`
      path: string
      count: number
      offset: string
    }
  | {
      type: `webhook_received`
      consumer_id: string
      epoch: number
      wake_id: string
      streams: Array<StreamInfo>
      triggered_by: Array<string>
      callback: string
      token: string
      signatureHeader: string | null
      body: string
    }
  | { type: `webhook_responded`; status: number; body: unknown }
  | {
      type: `callback_sent`
      token: string
      epoch: number
      wake_id?: string
      acks?: Array<AckInfo>
      subscribe?: Array<string>
      unsubscribe?: Array<string>
      done?: boolean
    }
  | {
      type: `callback_response`
      ok: boolean
      status: number
      error?: { code: string; message: string }
      token?: string
      streams?: Array<StreamInfo>
    }
  | { type: `subscription_deleted`; id: string }

export interface StreamInfo {
  path: string
  offset: string
}

export interface AckInfo {
  path: string
  offset: string
}

// ============================================================================
// Webhook Notification (received by the test receiver)
// ============================================================================

interface WebhookNotification {
  body: string
  parsed: {
    consumer_id: string
    epoch: number
    wake_id: string
    primary_stream: string
    streams: Array<StreamInfo>
    triggered_by: Array<string>
    callback: string
    token: string
  }
  signatureHeader: string | null
  resolve: (response: { status: number; body: string }) => void
}

// ============================================================================
// Webhook Receiver — local HTTP server for receiving POSTs
// ============================================================================

class WebhookReceiver {
  private server: Server | null = null
  private _url: string | null = null
  private notifications: Array<WebhookNotification> = []
  private waitResolvers: Array<() => void> = []
  private consumedCount = 0

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createHttpServer((req, res) => {
        this.handleRequest(req, res)
      })
      this.server.on(`error`, reject)
      this.server.listen(0, `127.0.0.1`, () => {
        const addr = this.server!.address()
        if (typeof addr === `object` && addr) {
          this._url = `http://127.0.0.1:${addr.port}`
        }
        resolve(this._url!)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    return new Promise((resolve) => {
      this.server!.closeAllConnections()
      this.server!.close(() => {
        this.server = null
        this._url = null
        resolve()
      })
    })
  }

  get url(): string {
    if (!this._url) throw new Error(`WebhookReceiver not started`)
    return this._url
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Array<Buffer> = []
    req.on(`data`, (chunk: Buffer) => chunks.push(chunk))
    req.on(`end`, () => {
      const body = Buffer.concat(chunks).toString(`utf-8`)
      const signatureHeader = req.headers[`webhook-signature`] as
        | string
        | undefined

      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400)
        res.end(`Invalid JSON`)
        return
      }

      const notification: WebhookNotification = {
        body,
        parsed,
        signatureHeader: signatureHeader ?? null,
        resolve: (response) => {
          res.writeHead(response.status, {
            "content-type": `application/json`,
          })
          res.end(response.body)
        },
      }

      this.notifications.push(notification)
      for (const waiter of this.waitResolvers) {
        waiter()
      }
      this.waitResolvers = []
    })
  }

  async waitForNotification(timeoutMs = 10_000): Promise<WebhookNotification> {
    const targetIdx = this.consumedCount
    this.consumedCount++

    if (this.notifications.length > targetIdx) {
      return this.notifications[targetIdx]!
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for webhook notification after ${timeoutMs}ms`
          )
        )
      }, timeoutMs)

      const check = () => {
        if (this.notifications.length > targetIdx) {
          clearTimeout(timeout)
          resolve(this.notifications[targetIdx]!)
        } else {
          this.waitResolvers.push(check)
        }
      }
      check()
    })
  }

  async expectNoNotification(timeoutMs = 500): Promise<void> {
    const startCount = this.notifications.length
    await new Promise((r) => setTimeout(r, timeoutMs))
    expect(this.notifications.length).toBe(startCount)
  }

  clear(): void {
    this.notifications = []
    this.consumedCount = 0
  }

  get received(): Array<WebhookNotification> {
    return this.notifications
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function callCallback(
  callbackUrl: string,
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(callbackUrl, {
    method: `POST`,
    headers: {
      "content-type": `application/json`,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const resBody = await res.json()
  return { status: res.status, body: resBody as Record<string, unknown> }
}

function verifySignature(
  body: string,
  signatureHeader: string,
  secret: string
): boolean {
  const match = signatureHeader.match(/t=(\d+),sha256=([a-f0-9]+)/)
  if (!match) return false
  const [, timestamp, signature] = match
  const payload = `${timestamp}.${body}`
  const expected = createHmac(`sha256`, secret).update(payload).digest(`hex`)
  return signature === expected
}

// ============================================================================
// Step Types — each method on the builder adds a Step
// ============================================================================

type Step =
  | { kind: `subscription`; pattern: string; id: string }
  | { kind: `stream`; path: string }
  | { kind: `append`; path: string | null; data: unknown }
  | { kind: `appendTo`; path: string; data: unknown }
  | { kind: `expectWake`; opts?: ExpectWakeOpts }
  | { kind: `respondDone` }
  | { kind: `respondOk`; body?: Record<string, unknown> }
  | { kind: `claimWake` }
  | { kind: `callback`; body: Record<string, unknown> }
  | { kind: `ack`; path: string; offset: string }
  | { kind: `ackAll` }
  | { kind: `subscribe`; paths: Array<string> }
  | { kind: `unsubscribe`; paths: Array<string> }
  | { kind: `done` }
  | { kind: `wait`; ms: number }
  | { kind: `deleteStream`; path: string }
  | { kind: `deleteSubscription`; id: string }
  | { kind: `expectIdle` }
  | { kind: `expectError`; code: string; status?: number }
  | { kind: `expectCallbackOk` }
  | { kind: `expectStreams`; paths: Array<string> }
  | { kind: `expectGone` }
  | { kind: `rawCallback`; body: Record<string, unknown>; token?: string }
  | { kind: `rawWebhookResponse`; status: number; body: unknown }
  | { kind: `custom`; fn: (ctx: RunContext) => Promise<void> }

interface ExpectWakeOpts {
  epochIncremented?: boolean
  triggeredBy?: Array<string>
  timeoutMs?: number
}

// ============================================================================
// Run Context — mutable state during execution
// ============================================================================

interface RunContext {
  baseUrl: string
  receiver: WebhookReceiver
  history: Array<HistoryEvent>

  // Current subscription and secret
  subscriptionId: string | null
  subscriptionPattern: string | null
  webhookSecret: string | null

  // Current stream (the last one created or appended to)
  currentStream: string | null

  // Current notification (from last expectWake)
  notification: WebhookNotification | null

  // Current callback state
  callbackUrl: string | null
  currentToken: string | null
  currentEpoch: number | null
  currentWakeId: string | null
  wakeClaimed: boolean

  // Last callback response
  lastCallbackResult: { status: number; body: Record<string, unknown> } | null

  // Track latest offsets per stream (from appends)
  tailOffsets: Map<string, string>
}

// ============================================================================
// WebhookScenario — Fluent builder
// ============================================================================

export class WebhookScenario {
  private baseUrl: string
  private steps: Array<Step> = []
  private _skipInvariants = false

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  // --- Setup ---

  subscription(pattern: string, id: string): this {
    this.steps.push({ kind: `subscription`, pattern, id })
    return this
  }

  stream(path: string): this {
    this.steps.push({ kind: `stream`, path })
    return this
  }

  streams(paths: Array<string>): this {
    for (const p of paths) {
      this.steps.push({ kind: `stream`, path: p })
    }
    return this
  }

  // --- Actions ---

  append(data: unknown): this {
    this.steps.push({ kind: `append`, path: null, data })
    return this
  }

  appendTo(path: string, data: unknown): this {
    this.steps.push({ kind: `appendTo`, path, data })
    return this
  }

  expectWake(opts?: ExpectWakeOpts): this {
    this.steps.push({ kind: `expectWake`, opts })
    return this
  }

  respondDone(): this {
    this.steps.push({ kind: `respondDone` })
    return this
  }

  respondOk(body?: Record<string, unknown>): this {
    this.steps.push({ kind: `respondOk`, body })
    return this
  }

  claimWake(): this {
    this.steps.push({ kind: `claimWake` })
    return this
  }

  callback(body: Record<string, unknown>): this {
    this.steps.push({ kind: `callback`, body })
    return this
  }

  ack(path: string, offset: string): this {
    this.steps.push({ kind: `ack`, path, offset })
    return this
  }

  ackAll(): this {
    this.steps.push({ kind: `ackAll` })
    return this
  }

  subscribe(paths: Array<string>): this {
    this.steps.push({ kind: `subscribe`, paths })
    return this
  }

  unsubscribe(paths: Array<string>): this {
    this.steps.push({ kind: `unsubscribe`, paths })
    return this
  }

  done(): this {
    this.steps.push({ kind: `done` })
    return this
  }

  wait(ms: number): this {
    this.steps.push({ kind: `wait`, ms })
    return this
  }

  deleteStream(path: string): this {
    this.steps.push({ kind: `deleteStream`, path })
    return this
  }

  deleteSubscription(id: string): this {
    this.steps.push({ kind: `deleteSubscription`, id })
    return this
  }

  // --- Assertions ---

  expectIdle(): this {
    this.steps.push({ kind: `expectIdle` })
    return this
  }

  expectError(code: string, status?: number): this {
    this.steps.push({ kind: `expectError`, code, status })
    return this
  }

  expectCallbackOk(): this {
    this.steps.push({ kind: `expectCallbackOk` })
    return this
  }

  expectStreams(paths: Array<string>): this {
    this.steps.push({ kind: `expectStreams`, paths })
    return this
  }

  expectGone(): this {
    this.steps.push({ kind: `expectGone` })
    return this
  }

  // --- Tier 2: Raw ---

  rawCallback(body: Record<string, unknown>, token?: string): this {
    this.steps.push({ kind: `rawCallback`, body, token })
    return this
  }

  rawWebhookResponse(status: number, body: unknown): this {
    this.steps.push({ kind: `rawWebhookResponse`, status, body })
    return this
  }

  // --- Custom step ---

  custom(fn: (ctx: RunContext) => Promise<void>): this {
    this.steps.push({ kind: `custom`, fn })
    return this
  }

  // --- Config ---

  skipInvariants(): this {
    this._skipInvariants = true
    return this
  }

  // --- Execute ---

  async run(): Promise<Array<HistoryEvent>> {
    const receiver = new WebhookReceiver()
    await receiver.start()

    const ctx: RunContext = {
      baseUrl: this.baseUrl,
      receiver,
      history: [],
      subscriptionId: null,
      subscriptionPattern: null,
      webhookSecret: null,
      currentStream: null,
      notification: null,
      callbackUrl: null,
      currentToken: null,
      currentEpoch: null,
      currentWakeId: null,
      wakeClaimed: false,
      lastCallbackResult: null,
      tailOffsets: new Map(),
    }

    try {
      for (const step of this.steps) {
        await executeStep(ctx, step)
      }

      if (!this._skipInvariants) {
        checkInvariants(ctx.history, ctx.webhookSecret)
      }

      return ctx.history
    } finally {
      // Respond to any pending webhook notifications
      for (const n of receiver.received) {
        try {
          n.resolve({ status: 200, body: JSON.stringify({ done: true }) })
        } catch {
          // already responded
        }
      }
      await receiver.stop()
    }
  }
}

// ============================================================================
// Step Executor
// ============================================================================

async function executeStep(ctx: RunContext, step: Step): Promise<void> {
  switch (step.kind) {
    case `subscription`: {
      const res = await fetch(
        `${ctx.baseUrl}${step.pattern}?subscription=${step.id}`,
        {
          method: `PUT`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ webhook: `${ctx.receiver.url}/webhook` }),
        }
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.subscription_id).toBe(step.id)
      expect(body.webhook_secret).toBeDefined()

      ctx.subscriptionId = step.id
      ctx.subscriptionPattern = step.pattern
      ctx.webhookSecret = body.webhook_secret as string

      ctx.history.push({
        type: `subscription_created`,
        id: step.id,
        pattern: step.pattern,
        webhookSecret: ctx.webhookSecret,
      })
      break
    }

    case `stream`: {
      await fetch(`${ctx.baseUrl}${step.path}`, {
        method: `PUT`,
        headers: { "content-type": `application/json` },
        body: `[]`,
      })
      ctx.currentStream = step.path
      ctx.history.push({ type: `stream_created`, path: step.path })
      break
    }

    case `append`:
    case `appendTo`: {
      const path =
        step.kind === `appendTo` ? step.path : (ctx.currentStream ?? ``)
      if (!path) throw new Error(`No current stream for append`)

      const res = await fetch(`${ctx.baseUrl}${path}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(step.data),
      })
      expect(res.status).toBe(204)
      const offset = res.headers.get(STREAM_OFFSET_HEADER)!
      ctx.tailOffsets.set(path, offset)
      ctx.currentStream = path

      ctx.history.push({
        type: `events_appended`,
        path,
        count: Array.isArray(step.data) ? step.data.length : 1,
        offset,
      })
      break
    }

    case `expectWake`: {
      const timeoutMs = step.opts?.timeoutMs ?? 10_000
      let notification = await ctx.receiver.waitForNotification(timeoutMs)

      // If we expect a new epoch but receive a stale retry (same or lower
      // epoch from the previous wake cycle), auto-respond with {done: true}
      // and wait for the real notification. This handles CI timing races
      // where a retry fires before the server processes the done response.
      if (step.opts?.epochIncremented && ctx.currentEpoch !== null) {
        while (notification.parsed.epoch <= ctx.currentEpoch) {
          notification.resolve({
            status: 200,
            body: JSON.stringify({ done: true }),
          })
          notification = await ctx.receiver.waitForNotification(timeoutMs)
        }
      }

      expect(notification.parsed.consumer_id).toBeDefined()
      expect(notification.parsed.epoch).toBeGreaterThan(0)
      expect(notification.parsed.wake_id).toBeDefined()
      expect(notification.parsed.callback).toBeDefined()
      expect(notification.parsed.token).toBeDefined()

      if (step.opts?.triggeredBy) {
        for (const path of step.opts.triggeredBy) {
          expect(notification.parsed.triggered_by).toContain(path)
        }
      }

      ctx.notification = notification
      ctx.callbackUrl = notification.parsed.callback
      ctx.currentToken = notification.parsed.token
      ctx.currentEpoch = notification.parsed.epoch
      ctx.currentWakeId = notification.parsed.wake_id
      ctx.wakeClaimed = false

      ctx.history.push({
        type: `webhook_received`,
        consumer_id: notification.parsed.consumer_id,
        epoch: notification.parsed.epoch,
        wake_id: notification.parsed.wake_id,
        streams: notification.parsed.streams,
        triggered_by: notification.parsed.triggered_by,
        callback: notification.parsed.callback,
        token: notification.parsed.token,
        signatureHeader: notification.signatureHeader,
        body: notification.body,
      })
      break
    }

    case `respondDone`: {
      if (!ctx.notification) throw new Error(`No notification to respond to`)
      ctx.notification.resolve({
        status: 200,
        body: JSON.stringify({ done: true }),
      })
      ctx.history.push({
        type: `webhook_responded`,
        status: 200,
        body: { done: true },
      })
      ctx.notification = null

      // Wait briefly for server to process the response
      await new Promise((r) => setTimeout(r, 100))
      break
    }

    case `respondOk`: {
      if (!ctx.notification) throw new Error(`No notification to respond to`)
      ctx.notification.resolve({
        status: 200,
        body: JSON.stringify(step.body ?? {}),
      })
      ctx.history.push({
        type: `webhook_responded`,
        status: 200,
        body: step.body ?? {},
      })
      break
    }

    case `claimWake`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback URL or token — did you expectWake first?`)
      if (!ctx.currentEpoch || !ctx.currentWakeId)
        throw new Error(`No epoch or wake_id`)

      const cbBody = {
        epoch: ctx.currentEpoch,
        wake_id: ctx.currentWakeId,
      }

      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch,
        wake_id: ctx.currentWakeId,
      })

      const result = await callCallback(
        ctx.callbackUrl,
        ctx.currentToken,
        cbBody
      )
      expect(result.status).toBe(200)
      expect(result.body.ok).toBe(true)

      ctx.currentToken = result.body.token as string
      ctx.wakeClaimed = true

      ctx.history.push({
        type: `callback_response`,
        ok: true,
        status: 200,
        token: ctx.currentToken,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })
      break
    }

    case `callback`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback context`)

      const body: Record<string, unknown> = {
        epoch: ctx.currentEpoch,
        ...step.body,
      }

      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch!,
        ...(step.body as object),
      })

      const result = await callCallback(ctx.callbackUrl, ctx.currentToken, body)
      ctx.lastCallbackResult = result

      if (result.body.ok) {
        ctx.currentToken = result.body.token as string
      } else if (result.body.token) {
        ctx.currentToken = result.body.token as string
      }

      ctx.history.push({
        type: `callback_response`,
        ok: result.body.ok as boolean,
        status: result.status,
        error: result.body.error as
          | { code: string; message: string }
          | undefined,
        token: result.body.token as string | undefined,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })
      break
    }

    case `ack`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback context`)

      const acks = [{ path: step.path, offset: step.offset }]

      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch!,
        acks,
      })

      const result = await callCallback(ctx.callbackUrl, ctx.currentToken, {
        epoch: ctx.currentEpoch,
        acks,
      })
      expect(result.status).toBe(200)
      ctx.currentToken = result.body.token as string
      ctx.lastCallbackResult = result

      ctx.history.push({
        type: `callback_response`,
        ok: true,
        status: 200,
        token: ctx.currentToken,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })
      break
    }

    case `ackAll`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback context`)

      const acks: Array<AckInfo> = []
      for (const [path, offset] of ctx.tailOffsets) {
        acks.push({ path, offset })
      }

      if (acks.length === 0) break

      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch!,
        acks,
      })

      const result = await callCallback(ctx.callbackUrl, ctx.currentToken, {
        epoch: ctx.currentEpoch,
        acks,
      })
      expect(result.status).toBe(200)
      ctx.currentToken = result.body.token as string
      ctx.lastCallbackResult = result

      ctx.history.push({
        type: `callback_response`,
        ok: true,
        status: 200,
        token: ctx.currentToken,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })
      break
    }

    case `subscribe`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback context`)

      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch!,
        subscribe: step.paths,
      })

      const result = await callCallback(ctx.callbackUrl, ctx.currentToken, {
        epoch: ctx.currentEpoch,
        subscribe: step.paths,
      })
      expect(result.status).toBe(200)
      ctx.currentToken = result.body.token as string
      ctx.lastCallbackResult = result

      ctx.history.push({
        type: `callback_response`,
        ok: true,
        status: 200,
        token: ctx.currentToken,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })
      break
    }

    case `unsubscribe`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback context`)

      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch!,
        unsubscribe: step.paths,
      })

      const result = await callCallback(ctx.callbackUrl, ctx.currentToken, {
        epoch: ctx.currentEpoch,
        unsubscribe: step.paths,
      })
      ctx.currentToken =
        (result.body.token as string | undefined) ?? ctx.currentToken
      ctx.lastCallbackResult = result

      ctx.history.push({
        type: `callback_response`,
        ok: result.body.ok as boolean,
        status: result.status,
        error: result.body.error as
          | { code: string; message: string }
          | undefined,
        token: result.body.token as string | undefined,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })
      break
    }

    case `done`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback context`)

      // Respond to pending webhook BEFORE done callback to avoid
      // the server scheduling retries of the old payload
      if (ctx.notification) {
        ctx.notification.resolve({
          status: 200,
          body: JSON.stringify({}),
        })
        ctx.notification = null
      }

      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch!,
        done: true,
      })

      const result = await callCallback(ctx.callbackUrl, ctx.currentToken, {
        epoch: ctx.currentEpoch,
        done: true,
      })
      ctx.lastCallbackResult = result

      if (result.body.ok) {
        ctx.currentToken = result.body.token as string
      }

      ctx.history.push({
        type: `callback_response`,
        ok: result.body.ok as boolean,
        status: result.status,
        token: result.body.token as string | undefined,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })

      // Wait briefly for state transition
      await new Promise((r) => setTimeout(r, 100))
      break
    }

    case `wait`: {
      await new Promise((r) => setTimeout(r, step.ms))
      break
    }

    case `deleteStream`: {
      await fetch(`${ctx.baseUrl}${step.path}`, { method: `DELETE` })
      ctx.history.push({ type: `stream_deleted`, path: step.path })
      break
    }

    case `deleteSubscription`: {
      await fetch(
        `${ctx.baseUrl}${ctx.subscriptionPattern ?? `/**`}?subscription=${step.id}`,
        { method: `DELETE` }
      )
      ctx.history.push({ type: `subscription_deleted`, id: step.id })
      break
    }

    case `expectIdle`: {
      await ctx.receiver.expectNoNotification(500)
      break
    }

    case `expectError`: {
      if (!ctx.lastCallbackResult)
        throw new Error(`No callback result to check`)
      expect(ctx.lastCallbackResult.body.ok).toBe(false)
      const error = ctx.lastCallbackResult.body.error as Record<string, string>
      expect(error.code).toBe(step.code)
      if (step.status) {
        expect(ctx.lastCallbackResult.status).toBe(step.status)
      }
      break
    }

    case `expectCallbackOk`: {
      if (!ctx.lastCallbackResult)
        throw new Error(`No callback result to check`)
      expect(ctx.lastCallbackResult.body.ok).toBe(true)
      expect(ctx.lastCallbackResult.status).toBe(200)
      break
    }

    case `expectStreams`: {
      if (!ctx.lastCallbackResult)
        throw new Error(`No callback result to check`)
      const streams = ctx.lastCallbackResult.body.streams as Array<StreamInfo>
      const paths = streams.map((s) => s.path).sort()
      expect(paths).toEqual([...step.paths].sort())
      break
    }

    case `expectGone`: {
      if (!ctx.callbackUrl || !ctx.currentToken)
        throw new Error(`No callback context`)

      const result = await callCallback(ctx.callbackUrl, ctx.currentToken, {
        epoch: ctx.currentEpoch,
      })
      expect(result.status).toBe(410)
      expect((result.body.error as Record<string, string>).code).toBe(
        `CONSUMER_GONE`
      )

      ctx.lastCallbackResult = result
      ctx.history.push({
        type: `callback_sent`,
        token: ctx.currentToken,
        epoch: ctx.currentEpoch!,
      })
      ctx.history.push({
        type: `callback_response`,
        ok: false,
        status: 410,
        error: result.body.error as { code: string; message: string },
      })
      break
    }

    case `rawCallback`: {
      if (!ctx.callbackUrl) throw new Error(`No callback URL`)
      const token = step.token ?? ctx.currentToken ?? `invalid`

      ctx.history.push({
        type: `callback_sent`,
        token,
        epoch: (step.body.epoch ?? 0) as number,
        wake_id: step.body.wake_id as string | undefined,
        acks: step.body.acks as Array<AckInfo> | undefined,
        subscribe: step.body.subscribe as Array<string> | undefined,
        unsubscribe: step.body.unsubscribe as Array<string> | undefined,
        done: step.body.done as boolean | undefined,
      })

      const result = await callCallback(ctx.callbackUrl, token, step.body)
      ctx.lastCallbackResult = result

      if (result.body.token) {
        ctx.currentToken = result.body.token as string
      }

      ctx.history.push({
        type: `callback_response`,
        ok: result.body.ok as boolean,
        status: result.status,
        error: result.body.error as
          | { code: string; message: string }
          | undefined,
        token: result.body.token as string | undefined,
        streams: result.body.streams as Array<StreamInfo> | undefined,
      })
      break
    }

    case `rawWebhookResponse`: {
      if (!ctx.notification) throw new Error(`No notification to respond to`)
      ctx.notification.resolve({
        status: step.status,
        body:
          typeof step.body === `string` ? step.body : JSON.stringify(step.body),
      })
      ctx.history.push({
        type: `webhook_responded`,
        status: step.status,
        body: step.body,
      })
      break
    }

    case `custom`: {
      await step.fn(ctx)
      break
    }
  }
}

// ============================================================================
// Invariant Checkers
// ============================================================================

export function checkInvariants(
  history: Array<HistoryEvent>,
  webhookSecret: string | null
): void {
  // Safety invariants (S1-S8)
  checkEpochMonotonicity(history)
  checkWakeIdUniqueness(history)
  checkSingleClaim(history)
  checkTokenRotation(history)
  if (webhookSecret) {
    checkSignaturePresence(history, webhookSecret)
  }

  // Temporal / liveness properties (L1, L3)
  checkAppendTriggersWake(history)
  checkDoneWithPendingRewake(history)

  // Structural properties
  checkClaimPrecedesWake(history)
  checkAckMonotonicity(history)
}

/** S1: Epoch values in webhook notifications must be monotonically increasing. */
function checkEpochMonotonicity(history: Array<HistoryEvent>): void {
  const epochsByConsumer = new Map<string, Array<number>>()
  for (const event of history) {
    if (event.type === `webhook_received`) {
      const epochs = epochsByConsumer.get(event.consumer_id) ?? []
      epochs.push(event.epoch)
      epochsByConsumer.set(event.consumer_id, epochs)
    }
  }
  for (const [consumerId, epochs] of epochsByConsumer) {
    for (let i = 1; i < epochs.length; i++) {
      expect(
        epochs[i],
        `S1: Epoch must increase for consumer ${consumerId}: ${epochs[i - 1]} → ${epochs[i]}`
      ).toBeGreaterThan(epochs[i - 1]!)
    }
  }
}

/** S2: Each wake_id appears at most once per consumer. */
function checkWakeIdUniqueness(history: Array<HistoryEvent>): void {
  const wakeIdsByConsumer = new Map<string, Set<string>>()
  for (const event of history) {
    if (event.type === `webhook_received`) {
      const wakeIds = wakeIdsByConsumer.get(event.consumer_id) ?? new Set()
      expect(
        wakeIds.has(event.wake_id),
        `S2: Duplicate wake_id ${event.wake_id} for consumer ${event.consumer_id}`
      ).toBe(false)
      wakeIds.add(event.wake_id)
      wakeIdsByConsumer.set(event.consumer_id, wakeIds)
    }
  }
}

/** S3: A wake_id can be successfully claimed at most once. */
function checkSingleClaim(history: Array<HistoryEvent>): void {
  const claimedWakeIds = new Set<string>()
  for (let i = 0; i < history.length; i++) {
    const event = history[i]!
    if (event.type === `callback_sent` && event.wake_id) {
      // Look at the next event for the response
      const next = history[i + 1]
      if (next && next.type === `callback_response` && next.ok) {
        if (claimedWakeIds.has(event.wake_id)) {
          throw new Error(
            `S3: wake_id ${event.wake_id} claimed twice successfully`
          )
        }
        claimedWakeIds.add(event.wake_id)
      }
    }
  }
}

/** S5: Every successful callback response includes a new token. */
function checkTokenRotation(history: Array<HistoryEvent>): void {
  for (let i = 0; i < history.length; i++) {
    const event = history[i]!
    if (event.type === `callback_sent`) {
      const next = history[i + 1]
      if (next && next.type === `callback_response` && next.ok) {
        expect(
          next.token,
          `S5: Successful callback response must include a token`
        ).toBeDefined()
        expect(
          next.token,
          `S5: Token must rotate — request and response tokens should differ`
        ).not.toBe(event.token)
      }
    }
  }
}

/** S8: Every webhook notification must include a valid signature. */
function checkSignaturePresence(
  history: Array<HistoryEvent>,
  webhookSecret: string
): void {
  for (const event of history) {
    if (event.type === `webhook_received`) {
      expect(
        event.signatureHeader,
        `S8: Webhook-Signature header must be present`
      ).toBeDefined()
      expect(event.signatureHeader).not.toBeNull()
      const valid = verifySignature(
        event.body,
        event.signatureHeader!,
        webhookSecret
      )
      expect(valid, `S8: Webhook-Signature must be valid`).toBe(true)
    }
  }
}

// ============================================================================
// Temporal / Liveness Property Checkers
// ============================================================================

/**
 * L1 (bounded): After events_appended, if the consumer was idle (the previous
 * wake cycle ended with done), a webhook_received must eventually appear in the
 * remaining trace.
 *
 * Pattern: □(P ⇒ ◇Q) over finite trace — "whenever P, eventually Q"
 */
function checkAppendTriggersWake(history: Array<HistoryEvent>): void {
  let consumerIdle = false

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    // Track idle state: consumer becomes idle after a done callback response
    if (event.type === `callback_sent` && event.done === true) {
      const next = history[i + 1]
      if (next && next.type === `callback_response` && next.ok) {
        consumerIdle = true
      }
    }

    // Also idle after respondDone (webhook_responded with done:true)
    if (
      event.type === `webhook_responded` &&
      typeof event.body === `object` &&
      event.body !== null &&
      (event.body as Record<string, unknown>).done === true
    ) {
      consumerIdle = true
    }

    // Consumer is no longer idle once woken
    if (event.type === `webhook_received`) {
      consumerIdle = false
    }

    // Trigger: events_appended while consumer is idle
    if (event.type === `events_appended` && consumerIdle) {
      // Scan suffix for a webhook_received
      let found = false
      for (let j = i + 1; j < history.length; j++) {
        if (history[j]!.type === `webhook_received`) {
          found = true
          break
        }
      }
      if (!found) {
        throw new Error(
          `L1: events_appended at index ${i} (path: ${event.path}) while consumer was idle, ` +
            `but no webhook_received followed in the trace`
        )
      }
    }
  }
}

/**
 * L3 (bounded): If callback_sent has done:true AND events were appended since
 * the last webhook_received, a new webhook_received must follow in the trace.
 *
 * This catches the "done with pending work triggers re-wake" invariant.
 */
function checkDoneWithPendingRewake(history: Array<HistoryEvent>): void {
  // Track the latest appended offset per stream and latest acked offset per stream.
  // "Pending work" = any stream where appended offset > acked offset.
  const appendedOffsets = new Map<string, string>()
  const ackedOffsets = new Map<string, string>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    if (event.type === `webhook_received`) {
      // New wake cycle resets our tracking
      appendedOffsets.clear()
      ackedOffsets.clear()
    }

    if (event.type === `events_appended`) {
      appendedOffsets.set(event.path, event.offset)
    }

    // Track successful acks
    if (event.type === `callback_sent` && event.acks) {
      const next = history[i + 1]
      if (next && next.type === `callback_response` && next.ok) {
        for (const ack of event.acks) {
          const prev = ackedOffsets.get(ack.path)
          if (prev === undefined || ack.offset > prev) {
            ackedOffsets.set(ack.path, ack.offset)
          }
        }
      }
    }

    // Trigger: done callback sent — check if there's genuinely pending work
    if (event.type === `callback_sent` && event.done === true) {
      const next = history[i + 1]
      if (!next || next.type !== `callback_response` || !next.ok) continue

      // Determine if any stream has un-acked events
      let hasPending = false
      for (const [path, appendedOffset] of appendedOffsets) {
        const ackedOffset = ackedOffsets.get(path)
        if (ackedOffset === undefined || appendedOffset > ackedOffset) {
          hasPending = true
          break
        }
      }

      if (!hasPending) continue

      // Scan suffix for a new webhook_received
      let found = false
      for (let j = i + 2; j < history.length; j++) {
        if (history[j]!.type === `webhook_received`) {
          found = true
          break
        }
      }
      if (!found) {
        throw new Error(
          `L3: callback_sent done:true at index ${i} with un-acked events, ` +
            `but no re-wake (webhook_received) followed in the trace`
        )
      }
    }
  }
}

/**
 * Precedence: ¬Q W P — "P must happen before Q"
 *
 * A wake_id claim (callback_sent with wake_id) must be preceded by a
 * webhook_received containing that same wake_id.
 */
function checkClaimPrecedesWake(history: Array<HistoryEvent>): void {
  const receivedWakeIds = new Set<string>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    if (event.type === `webhook_received`) {
      receivedWakeIds.add(event.wake_id)
    }

    if (event.type === `callback_sent` && event.wake_id) {
      // Only flag successful claims — rejected claims (409) are fine
      const next = history[i + 1]
      if (!next || next.type !== `callback_response` || !next.ok) continue

      if (!receivedWakeIds.has(event.wake_id)) {
        throw new Error(
          `Precedence: callback_sent claimed wake_id ${event.wake_id} ` +
            `but no webhook_received with that wake_id preceded it`
        )
      }
    }
  }
}

/**
 * Absence: □¬P — "P never happens"
 *
 * Ack offsets for a given stream must never go backwards. A successful ack
 * callback with an offset less than a previously acked offset is a violation.
 */
function checkAckMonotonicity(history: Array<HistoryEvent>): void {
  const lastAckByStream = new Map<string, string>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!
    if (event.type !== `callback_sent` || !event.acks) continue

    // Check that the ack was successful
    const next = history[i + 1]
    if (!next || next.type !== `callback_response` || !next.ok) continue

    for (const ack of event.acks) {
      const prev = lastAckByStream.get(ack.path)
      if (prev !== undefined && ack.offset < prev) {
        throw new Error(
          `AckMonotonicity: ack for ${ack.path} went backwards: ` +
            `${prev} → ${ack.offset} at history index ${i}`
        )
      }
      lastAckByStream.set(ack.path, ack.offset)
    }
  }
}

// ============================================================================
// ENABLED Predicate & Consumer State Model
// ============================================================================

/** Action types that can be applied during a LIVE consumer session */
export type LiveAction =
  | `append`
  | `ack`
  | `subscribe`
  | `unsubscribe-secondary`
  | `keepalive`

/** Minimal consumer state model — tracks what's needed for ENABLED filtering */
export interface ConsumerModel {
  phase: `LIVE`
  subscribedToSecondary: boolean
  hasUnackedEvents: boolean
  appendCount: number
}

/** Returns which actions are valid in the current consumer state */
export function enabledActions(state: ConsumerModel): Array<LiveAction> {
  const enabled: Array<LiveAction> = [`append`, `keepalive`]
  if (state.hasUnackedEvents) enabled.push(`ack`)
  if (!state.subscribedToSecondary) enabled.push(`subscribe`)
  if (state.subscribedToSecondary) enabled.push(`unsubscribe-secondary`)
  return enabled
}

/** Advance the consumer model after taking an action */
export function applyAction(
  state: ConsumerModel,
  action: LiveAction
): ConsumerModel {
  switch (action) {
    case `append`:
      return {
        ...state,
        hasUnackedEvents: true,
        appendCount: state.appendCount + 1,
      }
    case `ack`:
      return { ...state, hasUnackedEvents: false }
    case `subscribe`:
      return { ...state, subscribedToSecondary: true }
    case `unsubscribe-secondary`:
      return { ...state, subscribedToSecondary: false }
    case `keepalive`:
      return state
  }
}

// ============================================================================
// Public factory
// ============================================================================

export function webhook(baseUrl: string): WebhookScenario {
  return new WebhookScenario(baseUrl)
}

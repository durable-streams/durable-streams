/**
 * Consumer Testing DSL — mechanism-independent L1 fluent builder,
 * history recorder, and invariant checkers.
 *
 * Usage:
 *   await consumer(baseUrl)
 *     .register('my-consumer', ['/stream-1'])
 *     .stream('/stream-1')
 *     .append('event-1')
 *     .acquire()
 *     .ack('/stream-1', '$latest')
 *     .release()
 *     .run()
 */

import { expect } from "vitest"
import { STREAM_OFFSET_HEADER } from "@durable-streams/client"

// ============================================================================
// History Event Types — L1 (mechanism-independent)
// ============================================================================

export type L1HistoryEvent =
  | { type: `stream_created`; path: string }
  | { type: `stream_deleted`; path: string }
  | {
      type: `events_appended`
      path: string
      count: number
      offset: string
    }
  | {
      type: `consumer_registered`
      consumer_id: string
      streams: Array<string>
      created: boolean
      lease_ttl_ms?: number
    }
  | { type: `consumer_deleted`; consumer_id: string }
  | {
      type: `consumer_info`
      consumer_id: string
      state: string
      epoch: number
      streams: Array<StreamInfo>
    }
  | {
      type: `epoch_acquired`
      consumer_id: string
      epoch: number
      token: string
      streams: Array<StreamInfo>
    }
  | {
      type: `epoch_acquire_failed`
      consumer_id: string
      status: number
      error: { code: string; message: string }
    }
  | {
      type: `ack_sent`
      consumer_id: string
      token: string
      offsets: Array<AckInfo>
    }
  | {
      type: `ack_response`
      ok: boolean
      status: number
      token?: string
      error?: { code: string; message: string; path?: string }
    }
  | {
      type: `release_sent`
      consumer_id: string
      token: string
    }
  | {
      type: `release_response`
      ok: boolean
      status: number
      state?: string
    }

export interface StreamInfo {
  path: string
  offset: string
}

export interface AckInfo {
  path: string
  offset: string
}

// ============================================================================
// Step Types — each method on the builder adds a Step
// ============================================================================

export type Step =
  | { kind: `stream`; path: string }
  | { kind: `append`; path: string | null; data: unknown }
  | { kind: `appendTo`; path: string; data: unknown }
  | {
      kind: `register`
      consumerId: string
      streams: Array<string>
      leaseTtlMs?: number
    }
  | { kind: `deleteConsumer`; consumerId: string }
  | { kind: `getConsumer`; consumerId: string }
  | { kind: `acquire`; consumerId?: string }
  | { kind: `tryAcquire`; consumerId?: string }
  | { kind: `ack`; path: string; offset: string }
  | { kind: `tryAck`; offsets: Array<AckInfo> }
  | { kind: `ackLatest` }
  | { kind: `ackAll` }
  | { kind: `heartbeat` }
  | { kind: `release`; consumerId?: string }
  | { kind: `tryRelease`; consumerId?: string }
  | { kind: `wait`; ms: number }
  | { kind: `deleteStream`; path: string }
  | { kind: `expectState`; state: string }
  | { kind: `expectAcquireError`; code: string; status?: number }
  | { kind: `expectAckError`; code: string; status?: number }
  | { kind: `expectStreams`; paths: Array<string> }
  | { kind: `expectOffset`; path: string; offset: string }
  | { kind: `custom`; fn: (ctx: ConsumerRunContext) => void | Promise<void> }

// ============================================================================
// Run Context — mutable state during execution
// ============================================================================

export interface ConsumerRunContext {
  baseUrl: string
  history: Array<L1HistoryEvent>
  consumerId: string | null
  currentToken: string | null
  currentEpoch: number | null
  currentStream: string | null
  tailOffsets: Map<string, string>
  lastResult: { status: number; body: Record<string, unknown> } | null
}

// ============================================================================
// ConsumerScenario — Fluent builder
// ============================================================================

export class ConsumerScenario {
  private baseUrl: string
  protected steps: Array<Step> = []
  private _skipInvariants = false

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  // --- Setup ---

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

  // --- Consumer lifecycle ---

  register(
    consumerId: string,
    streams: Array<string>,
    leaseTtlMs?: number
  ): this {
    this.steps.push({ kind: `register`, consumerId, streams, leaseTtlMs })
    return this
  }

  deleteConsumer(consumerId: string): this {
    this.steps.push({ kind: `deleteConsumer`, consumerId })
    return this
  }

  getConsumer(consumerId: string): this {
    this.steps.push({ kind: `getConsumer`, consumerId })
    return this
  }

  // --- Epoch management ---

  acquire(consumerId?: string): this {
    this.steps.push({ kind: `acquire`, consumerId })
    return this
  }

  tryAcquire(consumerId?: string): this {
    this.steps.push({ kind: `tryAcquire`, consumerId })
    return this
  }

  // --- Acking ---

  ack(path: string, offset: string): this {
    this.steps.push({ kind: `ack`, path, offset })
    return this
  }

  tryAck(offsets: Array<AckInfo>): this {
    this.steps.push({ kind: `tryAck`, offsets })
    return this
  }

  ackLatest(): this {
    this.steps.push({ kind: `ackLatest` })
    return this
  }

  ackAll(): this {
    this.steps.push({ kind: `ackAll` })
    return this
  }

  heartbeat(): this {
    this.steps.push({ kind: `heartbeat` })
    return this
  }

  // --- Release ---

  release(consumerId?: string): this {
    this.steps.push({ kind: `release`, consumerId })
    return this
  }

  tryRelease(consumerId?: string): this {
    this.steps.push({ kind: `tryRelease`, consumerId })
    return this
  }

  // --- Stream actions ---

  append(data: unknown): this {
    this.steps.push({ kind: `append`, path: null, data })
    return this
  }

  appendTo(path: string, data: unknown): this {
    this.steps.push({ kind: `appendTo`, path, data })
    return this
  }

  // --- Utilities ---

  wait(ms: number): this {
    this.steps.push({ kind: `wait`, ms })
    return this
  }

  deleteStream(path: string): this {
    this.steps.push({ kind: `deleteStream`, path })
    return this
  }

  // --- Assertions ---

  expectState(state: string): this {
    this.steps.push({ kind: `expectState`, state })
    return this
  }

  expectAcquireError(code: string, status?: number): this {
    this.steps.push({ kind: `expectAcquireError`, code, status })
    return this
  }

  expectAckError(code: string, status?: number): this {
    this.steps.push({ kind: `expectAckError`, code, status })
    return this
  }

  expectStreams(paths: Array<string>): this {
    this.steps.push({ kind: `expectStreams`, paths })
    return this
  }

  expectOffset(path: string, offset: string): this {
    this.steps.push({ kind: `expectOffset`, path, offset })
    return this
  }

  // --- Custom step ---

  custom(fn: (ctx: ConsumerRunContext) => void | Promise<void>): this {
    this.steps.push({ kind: `custom`, fn })
    return this
  }

  // --- Config ---

  skipInvariants(): this {
    this._skipInvariants = true
    return this
  }

  // --- Execute ---

  async run(): Promise<Array<L1HistoryEvent>> {
    const ctx: ConsumerRunContext = {
      baseUrl: this.baseUrl,
      history: [],
      consumerId: null,
      currentToken: null,
      currentEpoch: null,
      currentStream: null,
      tailOffsets: new Map(),
      lastResult: null,
    }

    for (const step of this.steps) {
      await executeConsumerStep(ctx, step)
    }

    if (!this._skipInvariants) {
      checkL1Invariants(ctx.history)
    }

    return ctx.history
  }
}

// ============================================================================
// Step Executor
// ============================================================================

export async function executeConsumerStep(
  ctx: ConsumerRunContext,
  step: Step
): Promise<void> {
  switch (step.kind) {
    case `stream`: {
      await fetch(`${ctx.baseUrl}${step.path}`, {
        method: `PUT`,
        headers: { "content-type": `application/json` },
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

    case `register`: {
      const body: Record<string, unknown> = {
        consumer_id: step.consumerId,
        streams: step.streams,
      }
      if (step.leaseTtlMs !== undefined) {
        body[`lease_ttl_ms`] = step.leaseTtlMs
      }
      const res = await postJson(`${ctx.baseUrl}/consumers`, body)
      ctx.consumerId = step.consumerId

      ctx.history.push({
        type: `consumer_registered`,
        consumer_id: step.consumerId,
        streams: step.streams,
        created: res.status === 201,
        ...(step.leaseTtlMs !== undefined
          ? { lease_ttl_ms: step.leaseTtlMs }
          : {}),
      })
      break
    }

    case `deleteConsumer`: {
      await fetch(`${ctx.baseUrl}/consumers/${step.consumerId}`, {
        method: `DELETE`,
      })
      ctx.history.push({
        type: `consumer_deleted`,
        consumer_id: step.consumerId,
      })
      break
    }

    case `getConsumer`: {
      const res = await fetch(`${ctx.baseUrl}/consumers/${step.consumerId}`)
      const body = (await res.json()) as Record<string, unknown>
      ctx.history.push({
        type: `consumer_info`,
        consumer_id: step.consumerId,
        state: body[`state`] as string,
        epoch: body[`epoch`] as number,
        streams: (body[`streams`] as Array<StreamInfo> | undefined) ?? [],
      })
      break
    }

    case `acquire`: {
      const id = step.consumerId ?? ctx.consumerId
      if (!id) throw new Error(`No consumer ID for acquire`)

      const res = await postJson(`${ctx.baseUrl}/consumers/${id}/acquire`, {})
      expect(res.status).toBe(200)

      ctx.currentToken = res.body[`token`] as string
      ctx.currentEpoch = res.body[`epoch`] as number

      ctx.history.push({
        type: `epoch_acquired`,
        consumer_id: id,
        epoch: ctx.currentEpoch,
        token: ctx.currentToken,
        streams: (res.body[`streams`] as Array<StreamInfo> | undefined) ?? [],
      })
      break
    }

    case `tryAcquire`: {
      const id = step.consumerId ?? ctx.consumerId
      if (!id) throw new Error(`No consumer ID for tryAcquire`)

      const res = await postJson(`${ctx.baseUrl}/consumers/${id}/acquire`, {})
      ctx.lastResult = res

      if (res.status === 200) {
        ctx.currentToken = res.body[`token`] as string
        ctx.currentEpoch = res.body[`epoch`] as number

        ctx.history.push({
          type: `epoch_acquired`,
          consumer_id: id,
          epoch: ctx.currentEpoch,
          token: ctx.currentToken,
          streams: (res.body[`streams`] as Array<StreamInfo> | undefined) ?? [],
        })
      } else {
        const errorBody = res.body[`error`] as
          | { code: string; message: string }
          | undefined

        ctx.history.push({
          type: `epoch_acquire_failed`,
          consumer_id: id,
          status: res.status,
          error: errorBody ?? { code: `UNKNOWN`, message: `Unknown error` },
        })
      }
      break
    }

    case `ack`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for ack`)
      const token = ctx.currentToken
      if (!token) throw new Error(`No token for ack`)

      let offset = step.offset
      if (offset === `$latest`) {
        const tail = ctx.tailOffsets.get(step.path)
        if (!tail) throw new Error(`No tail offset for path ${step.path}`)
        offset = tail
      }

      const offsets: Array<AckInfo> = [{ path: step.path, offset }]

      ctx.history.push({
        type: `ack_sent`,
        consumer_id: id,
        token,
        offsets,
      })

      const res = await postJson(
        `${ctx.baseUrl}/consumers/${id}/ack`,
        { offsets },
        token
      )

      expect(res.status).toBe(200)

      const responseToken = res.body[`token`] as string | undefined
      if (responseToken) {
        ctx.currentToken = responseToken
      }

      ctx.history.push({
        type: `ack_response`,
        ok: true,
        status: res.status,
        ...(responseToken ? { token: responseToken } : {}),
      })
      break
    }

    case `tryAck`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for tryAck`)
      const token = ctx.currentToken
      if (!token) throw new Error(`No token for tryAck`)

      const resolvedOffsets = step.offsets.map((o) => {
        if (o.offset === `$latest`) {
          const tail = ctx.tailOffsets.get(o.path)
          if (!tail) throw new Error(`No tail offset for path ${o.path}`)
          return { path: o.path, offset: tail }
        }
        return o
      })

      ctx.history.push({
        type: `ack_sent`,
        consumer_id: id,
        token,
        offsets: resolvedOffsets,
      })

      const res = await postJson(
        `${ctx.baseUrl}/consumers/${id}/ack`,
        { offsets: resolvedOffsets },
        token
      )
      ctx.lastResult = res

      const responseToken = res.body[`token`] as string | undefined
      if (responseToken && res.status === 200) {
        ctx.currentToken = responseToken
      }

      const errorBody = res.body[`error`] as
        | { code: string; message: string; path?: string }
        | undefined

      ctx.history.push({
        type: `ack_response`,
        ok: res.status === 200,
        status: res.status,
        ...(responseToken ? { token: responseToken } : {}),
        ...(errorBody ? { error: errorBody } : {}),
      })
      break
    }

    case `ackLatest`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for ackLatest`)
      const token = ctx.currentToken
      if (!token) throw new Error(`No token for ackLatest`)
      const path = ctx.currentStream
      if (!path) throw new Error(`No current stream for ackLatest`)
      const tail = ctx.tailOffsets.get(path)
      if (!tail) throw new Error(`No tail offset for path ${path}`)

      const offsets: Array<AckInfo> = [{ path, offset: tail }]

      ctx.history.push({
        type: `ack_sent`,
        consumer_id: id,
        token,
        offsets,
      })

      const res = await postJson(
        `${ctx.baseUrl}/consumers/${id}/ack`,
        { offsets },
        token
      )
      expect(res.status).toBe(200)

      const responseToken = res.body[`token`] as string | undefined
      if (responseToken) {
        ctx.currentToken = responseToken
      }

      ctx.history.push({
        type: `ack_response`,
        ok: true,
        status: res.status,
        ...(responseToken ? { token: responseToken } : {}),
      })
      break
    }

    case `ackAll`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for ackAll`)
      const token = ctx.currentToken
      if (!token) throw new Error(`No token for ackAll`)

      const offsets: Array<AckInfo> = []
      for (const [path, offset] of ctx.tailOffsets) {
        offsets.push({ path, offset })
      }

      ctx.history.push({
        type: `ack_sent`,
        consumer_id: id,
        token,
        offsets,
      })

      const res = await postJson(
        `${ctx.baseUrl}/consumers/${id}/ack`,
        { offsets },
        token
      )
      expect(res.status).toBe(200)

      const responseToken = res.body[`token`] as string | undefined
      if (responseToken) {
        ctx.currentToken = responseToken
      }

      ctx.history.push({
        type: `ack_response`,
        ok: true,
        status: res.status,
        ...(responseToken ? { token: responseToken } : {}),
      })
      break
    }

    case `heartbeat`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for heartbeat`)
      const token = ctx.currentToken
      if (!token) throw new Error(`No token for heartbeat`)

      ctx.history.push({
        type: `ack_sent`,
        consumer_id: id,
        token,
        offsets: [],
      })

      const res = await postJson(
        `${ctx.baseUrl}/consumers/${id}/ack`,
        { offsets: [] },
        token
      )
      expect(res.status).toBe(200)

      const responseToken = res.body[`token`] as string | undefined
      if (responseToken) {
        ctx.currentToken = responseToken
      }

      ctx.history.push({
        type: `ack_response`,
        ok: true,
        status: res.status,
        ...(responseToken ? { token: responseToken } : {}),
      })
      break
    }

    case `release`: {
      const id = step.consumerId ?? ctx.consumerId
      if (!id) throw new Error(`No consumer ID for release`)
      const token = ctx.currentToken
      if (!token) throw new Error(`No token for release`)

      ctx.history.push({
        type: `release_sent`,
        consumer_id: id,
        token,
      })

      const res = await postJson(
        `${ctx.baseUrl}/consumers/${id}/release`,
        {},
        token
      )
      expect(res.status).toBe(200)

      ctx.currentToken = null
      ctx.currentEpoch = null

      ctx.history.push({
        type: `release_response`,
        ok: true,
        status: res.status,
        state: res.body[`state`] as string | undefined,
      })
      break
    }

    case `tryRelease`: {
      const id = step.consumerId ?? ctx.consumerId
      if (!id) throw new Error(`No consumer ID for tryRelease`)
      const token = ctx.currentToken
      if (!token) throw new Error(`No token for tryRelease`)

      ctx.history.push({
        type: `release_sent`,
        consumer_id: id,
        token,
      })

      const res = await postJson(
        `${ctx.baseUrl}/consumers/${id}/release`,
        {},
        token
      )
      ctx.lastResult = res

      if (res.status === 200) {
        ctx.currentToken = null
        ctx.currentEpoch = null
      }

      ctx.history.push({
        type: `release_response`,
        ok: res.status === 200,
        status: res.status,
        state: res.body[`state`] as string | undefined,
      })
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

    case `expectState`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for expectState`)
      const res = await fetch(`${ctx.baseUrl}/consumers/${id}`)
      const body = (await res.json()) as Record<string, unknown>
      expect(body[`state`]).toBe(step.state)
      break
    }

    case `expectAcquireError`: {
      expect(ctx.lastResult).not.toBeNull()
      expect(ctx.lastResult!.status).toBe(step.status ?? 409)
      const errorBody = ctx.lastResult!.body[`error`] as
        | { code: string }
        | undefined
      expect(errorBody?.code).toBe(step.code)
      break
    }

    case `expectAckError`: {
      expect(ctx.lastResult).not.toBeNull()
      expect(ctx.lastResult!.status).toBe(step.status ?? 409)
      const errorBody = ctx.lastResult!.body[`error`] as
        | { code: string }
        | undefined
      expect(errorBody?.code).toBe(step.code)
      break
    }

    case `expectStreams`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for expectStreams`)
      const res = await fetch(`${ctx.baseUrl}/consumers/${id}`)
      const body = (await res.json()) as Record<string, unknown>
      const streams = (body[`streams`] as Array<StreamInfo> | undefined) ?? []
      const paths = streams.map((s) => s.path)
      expect(paths.sort()).toEqual(step.paths.sort())
      break
    }

    case `expectOffset`: {
      const id = ctx.consumerId
      if (!id) throw new Error(`No consumer ID for expectOffset`)
      const res = await fetch(`${ctx.baseUrl}/consumers/${id}`)
      const body = (await res.json()) as Record<string, unknown>
      const streams = (body[`streams`] as Array<StreamInfo> | undefined) ?? []
      const stream = streams.find((s) => s.path === step.path)
      expect(stream).toBeDefined()
      expect(stream!.offset).toBe(step.offset)
      break
    }

    case `custom`: {
      await step.fn(ctx)
      break
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

export async function postJson(
  url: string,
  body: object,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": `application/json`,
  }
  if (token) headers[`authorization`] = `Bearer ${token}`
  const res = await fetch(url, {
    method: `POST`,
    headers,
    body: JSON.stringify(body),
  })
  const resBody = (await res.json().catch(() => ({}))) as Record<
    string,
    unknown
  >
  return { status: res.status, body: resBody }
}

// ============================================================================
// Checker Metadata (per configurancy skill §5.5, §12.5)
// ============================================================================

/**
 * Each invariant checker declares its soundness and completeness so CI/CD
 * can trust results and future agents know checker limitations.
 */
export interface CheckerMetadata {
  /** No false positives: if checker flags a violation, it IS a violation */
  soundness: `complete` | `partial`
  /** Coverage: does the checker find ALL violations of this property in the trace? */
  completeness: `exhaustive` | `conditional` | `sampled`
  /** When completeness is conditional, what must the trace contain? */
  preconditions?: Array<string>
  description: string
}

// ============================================================================
// L1 Invariant Checkers
// ============================================================================

export const L1_CHECKER_METADATA: Record<string, CheckerMetadata> = {
  checkEpochMonotonicity: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Epochs for a consumer are strictly increasing across all epoch_acquired events`,
  },
  checkAckMonotonicity: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Acknowledged offsets per (consumer, stream) pair never regress`,
  },
  checkAcquireTokenPresent: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Every successful epoch_acquired event includes a non-empty token`,
  },
  checkStaleEpochRejection: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain an ack_sent with a stale (non-active) token`,
    ],
    description: `Acks using a superseded token are rejected (requires trace to include stale-token attempt)`,
  },
  checkHeartbeatPreservesCursor: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain a consumer_info event between a confirmed heartbeat and the next ack_sent for that consumer`,
    ],
    description: `Empty acks (heartbeats) are no-ops on the durable cursor — verified by checking consumer_info snapshots between heartbeat and next ack are unchanged from the pre-heartbeat cursor (seeded from epoch_acquired)`,
  },
}

export function checkL1Invariants(history: Array<L1HistoryEvent>): void {
  checkEpochMonotonicity(history)
  checkAckMonotonicity(history)
  checkAcquireTokenPresent(history)
  checkStaleEpochRejection(history)
  checkHeartbeatPreservesCursor(history)
}

/**
 * S1 (L1): Epoch values for a consumer are strictly increasing.
 * Every epoch_acquired for the same consumer_id must have a higher epoch
 * than the previous one.
 */
function checkEpochMonotonicity(history: Array<L1HistoryEvent>): void {
  const epochsByConsumer = new Map<string, Array<number>>()
  for (const event of history) {
    if (event.type === `epoch_acquired`) {
      const epochs = epochsByConsumer.get(event.consumer_id) ?? []
      epochs.push(event.epoch)
      epochsByConsumer.set(event.consumer_id, epochs)
    }
  }
  for (const [consumerId, epochs] of epochsByConsumer) {
    for (let i = 1; i < epochs.length; i++) {
      expect(
        epochs[i],
        `S1/L1: Epoch must increase for consumer ${consumerId}: ${epochs[i - 1]} → ${epochs[i]}`
      ).toBeGreaterThan(epochs[i - 1]!)
    }
  }
}

/**
 * S4 (L1): Acknowledged offsets per (consumer, stream) pair are monotonically non-decreasing.
 * A successful ack with an offset less than a previously acked offset is a violation.
 * Keyed by (consumer_id, path) — not path alone — because two independent consumers
 * can ack the same stream at different offsets without violating monotonicity.
 */
function checkAckMonotonicity(history: Array<L1HistoryEvent>): void {
  const lastAckByConsumerStream = new Map<string, string>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!
    if (event.type !== `ack_sent`) continue

    const next = history[i + 1]
    if (!next || next.type !== `ack_response` || !next.ok) continue

    for (const ack of event.offsets) {
      const key = `${event.consumer_id}:${ack.path}`
      const prev = lastAckByConsumerStream.get(key)
      if (prev !== undefined && ack.offset < prev) {
        throw new Error(
          `S4/L1: ack for ${event.consumer_id}:${ack.path} went backwards: ${prev} → ${ack.offset}`
        )
      }
      lastAckByConsumerStream.set(key, ack.offset)
    }
  }
}

/**
 * S5 (L1): Every successful epoch acquisition includes a token.
 */
function checkAcquireTokenPresent(history: Array<L1HistoryEvent>): void {
  for (const event of history) {
    if (event.type === `epoch_acquired`) {
      expect(
        event.token,
        `S5/L1: epoch_acquired must include token`
      ).toBeTruthy()
    }
  }
}

/**
 * S6 (L1): After a new epoch is acquired, acks with the old token are rejected.
 * Look for patterns: epoch_acquired(N) → epoch_acquired(N+1) → ack_sent(old_token) → ack_response(error)
 */
function checkStaleEpochRejection(history: Array<L1HistoryEvent>): void {
  const activeTokenByConsumer = new Map<string, string>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!
    if (event.type === `epoch_acquired`) {
      activeTokenByConsumer.set(event.consumer_id, event.token)
    }
    if (event.type === `ack_sent`) {
      const activeToken = activeTokenByConsumer.get(event.consumer_id)
      if (activeToken && event.token !== activeToken) {
        // Using a stale token — the next response MUST be an error
        const next = history[i + 1]
        if (next && next.type === `ack_response`) {
          expect(next.ok, `S6/L1: ack with stale token must be rejected`).toBe(
            false
          )
        }
      }
    }
  }
}

/**
 * LP3: Empty ack is the heartbeat shape — no durable cursor write.
 * After a heartbeat (ack with empty offsets), the consumer's stream offsets
 * must not change.
 */
export function checkHeartbeatPreservesCursor(
  history: Array<L1HistoryEvent>
): void {
  // Confirmed cursor: consumer_id → stream_path → offset
  // Updated only on ack_sent(non-empty) → ack_response(ok) pairs
  const confirmedCursor = new Map<string, Map<string, string>>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    // Seed cursor from epoch_acquired (initial cursor position from acquire).
    if (event.type === `epoch_acquired`) {
      if (!confirmedCursor.has(event.consumer_id)) {
        confirmedCursor.set(event.consumer_id, new Map())
      }
      const cursors = confirmedCursor.get(event.consumer_id)!
      for (const { path, offset } of event.streams) {
        cursors.set(path, offset)
      }
    }

    // Update confirmed cursor on successful non-empty ack pairs
    if (event.type === `ack_sent` && event.offsets.length > 0) {
      const resp = history[i + 1]
      if (resp?.type === `ack_response` && resp.ok) {
        if (!confirmedCursor.has(event.consumer_id)) {
          confirmedCursor.set(event.consumer_id, new Map())
        }
        const cursors = confirmedCursor.get(event.consumer_id)!
        for (const { path, offset } of event.offsets) {
          cursors.set(path, offset)
        }
      }
    }

    // Detect confirmed heartbeat: empty ack_sent → ack_response(ok)
    if (event.type === `ack_sent` && event.offsets.length === 0) {
      const resp = history[i + 1]
      if (resp?.type === `ack_response` && resp.ok) {
        const hbConsumer = event.consumer_id

        // Snapshot cursor before heartbeat
        const cursorBefore = new Map(
          confirmedCursor.get(hbConsumer) ?? new Map()
        )

        // Scan for consumer_info between heartbeat and next ack_sent
        for (let j = i + 2; j < history.length; j++) {
          const future = history[j]!

          // If we see a consumer_info snapshot, verify cursor unchanged
          if (
            future.type === `consumer_info` &&
            future.consumer_id === hbConsumer
          ) {
            for (const { path, offset } of future.streams) {
              const before = cursorBefore.get(path)
              if (before && offset !== before) {
                throw new Error(
                  `LP3: Heartbeat for '${hbConsumer}' at index ${i} changed ` +
                    `cursor on '${path}' (${before} → ${offset})`
                )
              }
            }
          }

          // Stop scanning at the next ack_sent for this consumer
          if (future.type === `ack_sent` && future.consumer_id === hbConsumer) {
            break
          }
        }
      }
    }
  }
}

// ============================================================================
// ENABLED Predicate & Consumer State Model
// ============================================================================

export type ConsumerAction =
  | `append`
  | `ack`
  | `heartbeat`
  | `acquire`
  | `release`

export interface L1ConsumerModel {
  state: `REGISTERED` | `READING`
  hasUnackedEvents: boolean
  appendCount: number
}

export function enabledConsumerActions(
  state: L1ConsumerModel
): Array<ConsumerAction> {
  const enabled: Array<ConsumerAction> = [`append`]
  if (state.state === `REGISTERED`) enabled.push(`acquire`)
  if (state.state === `READING`) {
    enabled.push(`acquire`, `heartbeat`, `release`)
    if (state.hasUnackedEvents) enabled.push(`ack`)
  }
  return enabled
}

export function applyConsumerAction(
  state: L1ConsumerModel,
  action: ConsumerAction
): L1ConsumerModel {
  switch (action) {
    case `append`:
      return {
        ...state,
        hasUnackedEvents: true,
        appendCount: state.appendCount + 1,
      }
    case `ack`:
      return { ...state, hasUnackedEvents: false }
    case `heartbeat`:
      return state
    case `acquire`:
      return { ...state, state: `READING` }
    case `release`:
      return { ...state, state: `REGISTERED` }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function consumer(baseUrl: string): ConsumerScenario {
  return new ConsumerScenario(baseUrl)
}

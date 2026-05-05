/**
 * Pull-Wake Testing DSL — fluent builder, wake stream reader, and invariant checkers.
 *
 * Usage:
 *   await pullWake(baseUrl, '/wake/test-1')
 *     .stream('/stream-1')
 *     .register('my-consumer', ['/stream-1'])
 *     .setWakePreference('my-consumer')
 *     .startWakeReader()
 *     .append({ event: 'created' })
 *     .expectWakeEvent()
 *     .claimViaAcquire()
 *     .ack('/stream-1', '$latest')
 *     .release()
 *     .run()
 */

import { expect } from "vitest"
import {
  checkL1Invariants,
  executeConsumerStep,
  postJson,
} from "./consumer-dsl"
import type {
  AckInfo,
  CheckerMetadata,
  ConsumerRunContext,
  L1HistoryEvent,
  Step as L1Step,
  StreamInfo,
} from "./consumer-dsl"

// ============================================================================
// History Event Types — L1 + Pull-Wake extensions
// ============================================================================

export type PullWakeHistoryEvent =
  | L1HistoryEvent
  | {
      type: `wake_event_received`
      consumer_id: string
      streams: Array<string>
      offset: string
    }
  | {
      type: `claimed_event_received`
      consumer_id: string
      stream_path: string
      offset: string
    }
  | {
      type: `claim_attempted`
      consumer_id: string
      worker?: string
    }
  | {
      type: `claim_succeeded`
      consumer_id: string
      epoch: number
      token: string
    }
  | {
      type: `claim_failed`
      consumer_id: string
      status: number
    }

// ============================================================================
// WakeStreamReader — SSE reader for the wake stream
// ============================================================================

interface WakeEvent {
  index: number
  data: Record<string, unknown>
}

export class WakeStreamReader {
  private baseUrl: string
  private wakeStreamPath: string
  private controller: AbortController | null = null
  private events: Array<WakeEvent> = []
  private waitResolvers: Array<() => void> = []
  private nextWakeSearchIndex = 0
  private nextClaimedSearchIndex = 0

  constructor(baseUrl: string, wakeStreamPath: string) {
    this.baseUrl = baseUrl
    this.wakeStreamPath = wakeStreamPath
  }

  async start(fromOffset?: string): Promise<void> {
    this.controller = new AbortController()
    const offset = fromOffset ?? `-1`
    const url = `${this.baseUrl}${this.wakeStreamPath}?offset=${offset}&live=sse`

    const res = await fetch(url, {
      headers: { accept: `text/event-stream` },
      signal: this.controller.signal,
    })

    if (!res.ok || !res.body) {
      throw new Error(
        `Failed to connect to wake stream: ${res.status} ${res.statusText}`
      )
    }

    // Read SSE in background
    this.readStream(res.body)
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ``
    let eventIndex = 0

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        const lines = buffer.split(`\n`)
        buffer = lines.pop()! // Keep incomplete line in buffer

        for (const line of lines) {
          // SSE spec: "data:" prefix, optionally followed by a single space
          // Server sends "data:VALUE" (no space); also handle "data: VALUE"
          let jsonStr: string | null = null
          if (line.startsWith(`data: `)) {
            jsonStr = line.slice(6)
          } else if (line.startsWith(`data:`)) {
            jsonStr = line.slice(5)
          }
          if (jsonStr !== null) {
            try {
              const parsed = JSON.parse(jsonStr)
              // The wake stream uses application/json content-type, so the
              // server SSE handler wraps each event in a JSON array.
              // Unwrap array items; otherwise treat as a plain object.
              const items: Array<Record<string, unknown>> = Array.isArray(
                parsed
              )
                ? (parsed as Array<Record<string, unknown>>)
                : [parsed as Record<string, unknown>]

              for (const data of items) {
                const event: WakeEvent = {
                  index: eventIndex++,
                  data,
                }
                this.events.push(event)
              }
              for (const waiter of this.waitResolvers) {
                waiter()
              }
              this.waitResolvers = []
            } catch {
              // Skip malformed JSON (e.g. control events with unexpected shape)
            }
          }
        }
      }
    } catch (err) {
      // AbortError is expected when stop() is called
      if (err instanceof DOMException && err.name === `AbortError`) return
      if (err instanceof Error && err.message.includes(`abort`)) return
      throw err
    }
  }

  async waitForWakeEvent(
    consumerId: string,
    timeoutMs = 10_000
  ): Promise<WakeEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for wake event for consumer '${consumerId}' after ${timeoutMs}ms`
          )
        )
      }, timeoutMs)

      const check = () => {
        for (let i = this.nextWakeSearchIndex; i < this.events.length; i++) {
          const evt = this.events[i]!
          // Match wake events by consumer field (server uses "consumer" not "consumer_id")
          if (
            evt.data.type === `wake` &&
            (evt.data.consumer === consumerId ||
              evt.data.consumer_id === consumerId)
          ) {
            this.nextWakeSearchIndex = i + 1
            clearTimeout(timeout)
            resolve(evt)
            return
          }
        }

        this.waitResolvers.push(check)
      }
      check()
    })
  }

  async waitForClaimedEvent(
    streamPath: string,
    timeoutMs = 5_000
  ): Promise<WakeEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for claimed event for stream '${streamPath}' after ${timeoutMs}ms`
          )
        )
      }, timeoutMs)

      const check = () => {
        for (let i = this.nextClaimedSearchIndex; i < this.events.length; i++) {
          const evt = this.events[i]!
          if (
            evt.data.type === `claimed` &&
            (evt.data.stream === streamPath ||
              evt.data.stream_path === streamPath ||
              evt.data.path === streamPath)
          ) {
            this.nextClaimedSearchIndex = i + 1
            clearTimeout(timeout)
            resolve(evt)
            return
          }
        }
        this.waitResolvers.push(check)
      }
      check()
    })
  }

  hasClaimedEventAfter(streamPath: string, afterIndex: number): boolean {
    for (const evt of this.events) {
      if (
        evt.index > afterIndex &&
        evt.data.type === `claimed` &&
        (evt.data.stream === streamPath ||
          evt.data.stream_path === streamPath ||
          evt.data.path === streamPath)
      ) {
        return true
      }
    }
    return false
  }

  stop(): void {
    if (this.controller) {
      this.controller.abort()
      this.controller = null
    }
  }

  get receivedEvents(): Array<WakeEvent> {
    return this.events
  }
}

// ============================================================================
// Step Types — L1 steps plus pull-wake specific steps
// ============================================================================

type PullWakeStep =
  | { kind: `l1`; step: L1Step }
  | { kind: `setWakePreference`; consumerId?: string }
  | { kind: `startWakeReader`; fromOffset?: string }
  | { kind: `expectWakeEvent`; consumerId?: string; timeoutMs?: number }
  | {
      kind: `claimViaAcquire`
      consumerId?: string
      worker?: string
    }
  | { kind: `expectClaimedEvent`; streamPath: string; timeoutMs?: number }
  | { kind: `expectNoWakeEvent`; timeoutMs?: number }
  | { kind: `expectClaimedSkip`; streamPath: string; afterIndex: number }
  | { kind: `custom`; fn: (ctx: PullWakeRunContext) => void | Promise<void> }
  | {
      kind: `rawAcquire`
      consumerId: string
      body: Record<string, unknown>
      expectedStatus: number
    }
  | {
      kind: `rawAck`
      consumerId: string
      token: string
      body: Record<string, unknown>
      expectedStatus: number
    }
  | { kind: `rawWakeEvent`; event: Record<string, unknown> }
  | { kind: `rawClaimedEvent`; event: Record<string, unknown> }

// ============================================================================
// Run Context — extends ConsumerRunContext with pull-wake fields
// ============================================================================

export interface PullWakeRunContext extends ConsumerRunContext {
  wakeStreamPath: string
  wakeReader: WakeStreamReader | null
  lastWakeIndexByStream: Map<string, number>
}

// ============================================================================
// PullWakeScenario — Fluent builder
// ============================================================================

export class PullWakeScenario {
  private baseUrl: string
  private wakeStreamPath: string
  private steps: Array<PullWakeStep> = []
  private _skipInvariants = false

  constructor(baseUrl: string, wakeStreamPath: string) {
    this.baseUrl = baseUrl
    this.wakeStreamPath = wakeStreamPath
  }

  // --- L1 pass-through methods ---

  stream(path: string): this {
    this.steps.push({ kind: `l1`, step: { kind: `stream`, path } })
    return this
  }

  streams(paths: Array<string>): this {
    for (const p of paths) {
      this.steps.push({ kind: `l1`, step: { kind: `stream`, path: p } })
    }
    return this
  }

  register(
    consumerId: string,
    streams: Array<string>,
    leaseTtlMs?: number
  ): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `register`, consumerId, streams, leaseTtlMs },
    })
    return this
  }

  deleteConsumer(consumerId: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `deleteConsumer`, consumerId },
    })
    return this
  }

  getConsumer(consumerId: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `getConsumer`, consumerId },
    })
    return this
  }

  acquire(consumerId?: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `acquire`, consumerId },
    })
    return this
  }

  tryAcquire(consumerId?: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `tryAcquire`, consumerId },
    })
    return this
  }

  ack(path: string, offset: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `ack`, path, offset },
    })
    return this
  }

  tryAck(offsets: Array<AckInfo>): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `tryAck`, offsets },
    })
    return this
  }

  ackLatest(): this {
    this.steps.push({ kind: `l1`, step: { kind: `ackLatest` } })
    return this
  }

  ackAll(): this {
    this.steps.push({ kind: `l1`, step: { kind: `ackAll` } })
    return this
  }

  heartbeat(): this {
    this.steps.push({ kind: `l1`, step: { kind: `heartbeat` } })
    return this
  }

  release(consumerId?: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `release`, consumerId },
    })
    return this
  }

  tryRelease(consumerId?: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `tryRelease`, consumerId },
    })
    return this
  }

  append(data: unknown): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `append`, path: null, data },
    })
    return this
  }

  appendTo(path: string, data: unknown): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `appendTo`, path, data },
    })
    return this
  }

  wait(ms: number): this {
    this.steps.push({ kind: `l1`, step: { kind: `wait`, ms } })
    return this
  }

  deleteStream(path: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `deleteStream`, path },
    })
    return this
  }

  expectState(state: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `expectState`, state },
    })
    return this
  }

  expectAcquireError(code: string, status?: number): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `expectAcquireError`, code, status },
    })
    return this
  }

  expectAckError(code: string, status?: number): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `expectAckError`, code, status },
    })
    return this
  }

  expectStreams(paths: Array<string>): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `expectStreams`, paths },
    })
    return this
  }

  expectOffset(path: string, offset: string): this {
    this.steps.push({
      kind: `l1`,
      step: { kind: `expectOffset`, path, offset },
    })
    return this
  }

  // --- Pull-Wake specific methods ---

  setWakePreference(consumerId?: string): this {
    this.steps.push({ kind: `setWakePreference`, consumerId })
    return this
  }

  startWakeReader(fromOffset?: string): this {
    this.steps.push({ kind: `startWakeReader`, fromOffset })
    return this
  }

  expectWakeEvent(consumerId?: string, timeoutMs?: number): this {
    this.steps.push({ kind: `expectWakeEvent`, consumerId, timeoutMs })
    return this
  }

  claimViaAcquire(consumerId?: string, worker?: string): this {
    this.steps.push({ kind: `claimViaAcquire`, consumerId, worker })
    return this
  }

  expectClaimedEvent(streamPath: string, timeoutMs?: number): this {
    this.steps.push({ kind: `expectClaimedEvent`, streamPath, timeoutMs })
    return this
  }

  expectNoWakeEvent(timeoutMs?: number): this {
    this.steps.push({ kind: `expectNoWakeEvent`, timeoutMs })
    return this
  }

  expectClaimedSkip(streamPath: string, afterIndex: number): this {
    this.steps.push({ kind: `expectClaimedSkip`, streamPath, afterIndex })
    return this
  }

  // --- Custom step ---

  custom(fn: (ctx: PullWakeRunContext) => void | Promise<void>): this {
    this.steps.push({ kind: `custom`, fn })
    return this
  }

  // --- Tier 2: Raw / Adversarial methods ---

  rawAcquire(
    consumerId: string,
    body: Record<string, unknown>,
    expectedStatus: number
  ): this {
    this.steps.push({ kind: `rawAcquire`, consumerId, body, expectedStatus })
    return this
  }

  rawAck(
    consumerId: string,
    token: string,
    body: Record<string, unknown>,
    expectedStatus: number
  ): this {
    this.steps.push({ kind: `rawAck`, consumerId, token, body, expectedStatus })
    return this
  }

  rawWakeEvent(event: Record<string, unknown>): this {
    this.steps.push({ kind: `rawWakeEvent`, event })
    return this
  }

  rawClaimedEvent(event: Record<string, unknown>): this {
    this.steps.push({ kind: `rawClaimedEvent`, event })
    return this
  }

  // --- Config ---

  skipInvariants(): this {
    this._skipInvariants = true
    return this
  }

  // --- Execute ---

  async run(): Promise<Array<PullWakeHistoryEvent>> {
    const ctx: PullWakeRunContext = {
      baseUrl: this.baseUrl,
      history: [],
      consumerId: null,
      currentToken: null,
      currentEpoch: null,
      currentStream: null,
      tailOffsets: new Map(),
      lastResult: null,
      wakeStreamPath: this.wakeStreamPath,
      wakeReader: null,
      lastWakeIndexByStream: new Map(),
    }

    // Cast history to PullWakeHistoryEvent array — L1 events are a subset
    const history = ctx.history as unknown as Array<PullWakeHistoryEvent>

    try {
      for (const step of this.steps) {
        await executePullWakeStep(ctx, step, history)
      }

      if (!this._skipInvariants) {
        checkPullWakeInvariants(history)
      }

      return history
    } finally {
      if (ctx.wakeReader) {
        ctx.wakeReader.stop()
      }
    }
  }
}

// ============================================================================
// Step Executor
// ============================================================================

async function executePullWakeStep(
  ctx: PullWakeRunContext,
  step: PullWakeStep,
  history: Array<PullWakeHistoryEvent>
): Promise<void> {
  switch (step.kind) {
    case `l1`: {
      await executeConsumerStep(ctx, step.step)
      break
    }

    case `setWakePreference`: {
      const id = step.consumerId ?? ctx.consumerId
      if (!id) throw new Error(`No consumer ID for setWakePreference`)

      const res = await fetch(`${ctx.baseUrl}/consumers/${id}/wake`, {
        method: `PUT`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({
          type: `pull-wake`,
          wake_stream: ctx.wakeStreamPath,
        }),
      })
      expect(res.status).toBe(200)
      break
    }

    case `startWakeReader`: {
      const reader = new WakeStreamReader(ctx.baseUrl, ctx.wakeStreamPath)
      await reader.start(step.fromOffset)
      ctx.wakeReader = reader

      // Give the SSE connection a moment to establish
      await new Promise((r) => setTimeout(r, 100))
      break
    }

    case `expectWakeEvent`: {
      if (!ctx.wakeReader)
        throw new Error(`No wake reader — call startWakeReader() first`)
      const id = step.consumerId ?? ctx.consumerId
      if (!id) throw new Error(`No consumer ID for expectWakeEvent`)

      const timeoutMs = step.timeoutMs ?? 10_000
      const evt = await ctx.wakeReader.waitForWakeEvent(id, timeoutMs)

      const streams = Array.isArray(evt.data.streams)
        ? (evt.data.streams as Array<string>)
        : typeof evt.data.stream === `string`
          ? [evt.data.stream]
          : []
      const offset = String(evt.data.offset ?? evt.index)

      history.push({
        type: `wake_event_received`,
        consumer_id: id,
        streams,
        offset,
      })

      // Track the last wake index per stream for claimed-skip checks
      for (const s of streams) {
        ctx.lastWakeIndexByStream.set(s, evt.index)
      }
      break
    }

    case `claimViaAcquire`: {
      const id = step.consumerId ?? ctx.consumerId
      if (!id) throw new Error(`No consumer ID for claimViaAcquire`)

      const body: Record<string, unknown> = {}
      if (step.worker) {
        body.worker = step.worker
      }

      history.push({
        type: `claim_attempted`,
        consumer_id: id,
        ...(step.worker ? { worker: step.worker } : {}),
      })

      const res = await postJson(`${ctx.baseUrl}/consumers/${id}/acquire`, body)
      ctx.lastResult = res

      if (res.status === 200) {
        ctx.currentToken = res.body.token as string
        ctx.currentEpoch = res.body.epoch as number

        history.push({
          type: `claim_succeeded`,
          consumer_id: id,
          epoch: ctx.currentEpoch,
          token: ctx.currentToken,
        })

        // Also record as L1 epoch_acquired so L1 checkers see the acquire
        history.push({
          type: `epoch_acquired`,
          consumer_id: id,
          epoch: ctx.currentEpoch,
          token: ctx.currentToken,
          streams: (res.body.streams as Array<StreamInfo> | undefined) ?? [],
        })
      } else {
        history.push({
          type: `claim_failed`,
          consumer_id: id,
          status: res.status,
        })
      }
      break
    }

    case `expectClaimedEvent`: {
      if (!ctx.wakeReader)
        throw new Error(`No wake reader — call startWakeReader() first`)

      const timeoutMs = step.timeoutMs ?? 5_000
      const evt = await ctx.wakeReader.waitForClaimedEvent(
        step.streamPath,
        timeoutMs
      )

      const id =
        (evt.data.consumer_id as string | undefined) ??
        ctx.consumerId ??
        `unknown`

      history.push({
        type: `claimed_event_received`,
        consumer_id: id,
        stream_path: step.streamPath,
        offset: String(evt.data.offset ?? evt.index),
      })
      break
    }

    case `expectNoWakeEvent`: {
      if (!ctx.wakeReader)
        throw new Error(`No wake reader — call startWakeReader() first`)

      const timeoutMs = step.timeoutMs ?? 500
      const beforeCount = ctx.wakeReader.receivedEvents.length
      await new Promise((r) => setTimeout(r, timeoutMs))
      const afterCount = ctx.wakeReader.receivedEvents.length

      // Check that no new wake events arrived for this consumer
      const id = ctx.consumerId
      if (id) {
        for (let i = beforeCount; i < afterCount; i++) {
          const evt = ctx.wakeReader.receivedEvents[i]!
          const isMatch =
            evt.data.consumer === id || evt.data.consumer_id === id
          expect(
            isMatch,
            `Expected no wake event for consumer '${id}' but got one`
          ).toBe(false)
        }
      } else {
        expect(afterCount).toBe(beforeCount)
      }
      break
    }

    case `expectClaimedSkip`: {
      if (!ctx.wakeReader)
        throw new Error(`No wake reader — call startWakeReader() first`)

      const hasClaimed = ctx.wakeReader.hasClaimedEventAfter(
        step.streamPath,
        step.afterIndex
      )
      expect(
        hasClaimed,
        `Expected a claimed event for '${step.streamPath}' after index ${step.afterIndex}`
      ).toBe(true)
      break
    }

    case `rawAcquire`: {
      const res = await fetch(
        `${ctx.baseUrl}/consumers/${step.consumerId}/acquire`,
        {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify(step.body),
        }
      )
      expect(res.status, `rawAcquire expected ${step.expectedStatus}`).toBe(
        step.expectedStatus
      )
      ctx.history.push({
        type: `raw_acquire_sent`,
        consumer_id: step.consumerId,
        body: step.body,
        status: res.status,
      } as any)
      break
    }

    case `rawAck`: {
      const res = await fetch(
        `${ctx.baseUrl}/consumers/${step.consumerId}/ack`,
        {
          method: `POST`,
          headers: {
            "content-type": `application/json`,
            authorization: `Bearer ${step.token}`,
          },
          body: JSON.stringify(step.body),
        }
      )
      expect(res.status, `rawAck expected ${step.expectedStatus}`).toBe(
        step.expectedStatus
      )
      break
    }

    case `rawWakeEvent`: {
      await fetch(`${ctx.baseUrl}${ctx.wakeStreamPath}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(step.event),
      })
      break
    }

    case `rawClaimedEvent`: {
      await fetch(`${ctx.baseUrl}${ctx.wakeStreamPath}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(step.event),
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
// Checker Metadata
// ============================================================================

export const PULL_WAKE_CHECKER_METADATA: Record<string, CheckerMetadata> = {
  checkClaimedFollowsClaim: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Every claimed_event_received has a preceding claim_succeeded for the same consumer`,
  },
  checkPullWakeAppendTriggersWake: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain an events_appended while consumer is REGISTERED with pending work`,
    ],
    description: `Append to a REGISTERED consumer with pending work triggers a wake event before the next epoch_acquired`,
  },
  checkPullWakeReleaseRewake: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain a release_response(ok) with un-acked events`,
    ],
    description: `Release with pending work triggers a wake event before the next epoch_acquired`,
  },
}

// ============================================================================
// Pull-Wake Invariant Checkers
// ============================================================================

export function checkPullWakeInvariants(
  history: Array<PullWakeHistoryEvent>
): void {
  // Run L1 invariants on the L1 events extracted from the history
  const l1Events = extractL1Events(history)
  checkL1Invariants(l1Events)

  // Pull-wake specific invariants
  checkClaimedFollowsClaim(history)
  checkPullWakeAppendTriggersWake(history)
  checkPullWakeReleaseRewake(history)
}

/**
 * Extract L1 history events from the pull-wake history.
 */
function extractL1Events(
  history: Array<PullWakeHistoryEvent>
): Array<L1HistoryEvent> {
  const l1: Array<L1HistoryEvent> = []
  for (const event of history) {
    switch (event.type) {
      case `stream_created`:
      case `stream_deleted`:
      case `events_appended`:
      case `consumer_registered`:
      case `consumer_deleted`:
      case `consumer_info`:
      case `epoch_acquired`:
      case `epoch_acquire_failed`:
      case `ack_sent`:
      case `ack_response`:
      case `release_sent`:
      case `release_response`:
        l1.push(event)
        break
    }
  }
  return l1
}

/**
 * PW-S1: Every claimed_event_received has a preceding claim_succeeded
 * for the same consumer.
 */
function checkClaimedFollowsClaim(history: Array<PullWakeHistoryEvent>): void {
  const claimedConsumers = new Set<string>()

  for (const event of history) {
    if (event.type === `claim_succeeded`) {
      claimedConsumers.add(event.consumer_id)
    }
    if (event.type === `claimed_event_received`) {
      expect(
        claimedConsumers.has(event.consumer_id),
        `PW-S1: claimed_event_received for consumer '${event.consumer_id}' ` +
          `without a preceding claim_succeeded`
      ).toBe(true)
    }
  }
}

/**
 * PW-L1 (bounded): After events_appended, if the consumer is REGISTERED
 * (not currently in a READING epoch), a wake_event_received must appear
 * in the trace before the next epoch_acquired for that consumer.
 *
 * Pattern: □(P => ◇Q before R) — "whenever P, Q must occur before R"
 */
function checkPullWakeAppendTriggersWake(
  history: Array<PullWakeHistoryEvent>
): void {
  // Track consumer state: REGISTERED vs READING
  let consumerState: `REGISTERED` | `READING` | null = null
  let consumerId: string | null = null

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    if (event.type === `consumer_registered`) {
      consumerState = `REGISTERED`
      consumerId = event.consumer_id
    }

    if (event.type === `epoch_acquired`) {
      consumerState = `READING`
    }

    if (event.type === `release_response` && event.ok) {
      consumerState = `REGISTERED`
    }

    // Trigger: append while consumer is REGISTERED
    if (
      event.type === `events_appended` &&
      consumerState === `REGISTERED` &&
      consumerId
    ) {
      // Scan suffix for wake_event_received before next epoch_acquired
      for (let j = i + 1; j < history.length; j++) {
        const future = history[j]!
        if (
          future.type === `wake_event_received` &&
          future.consumer_id === consumerId
        ) {
          break
        }
        if (
          future.type === `epoch_acquired` &&
          future.consumer_id === consumerId
        ) {
          throw new Error(
            `PW-L1: events_appended at index ${i} (path: ${event.path}) ` +
              `while consumer '${consumerId}' was REGISTERED, but no ` +
              `wake_event_received preceded the next epoch_acquired`
          )
        }
      }
    }
  }
}

/**
 * PW-L3 (bounded): If release_response(ok) fires while there are un-acked
 * events, a wake_event_received must appear before the next epoch_acquired
 * for that consumer.
 *
 * This catches the "release with pending work triggers re-wake" invariant.
 */
function checkPullWakeReleaseRewake(
  history: Array<PullWakeHistoryEvent>
): void {
  const appendedOffsets = new Map<string, string>()
  const ackedOffsets = new Map<string, string>()
  let consumerId: string | null = null

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    if (event.type === `consumer_registered`) {
      consumerId = event.consumer_id
    }

    if (event.type === `events_appended`) {
      appendedOffsets.set(event.path, event.offset)
    }

    // Track successful acks
    if (event.type === `ack_sent`) {
      const next = history[i + 1]
      if (next && next.type === `ack_response` && next.ok) {
        for (const ack of event.offsets) {
          const prev = ackedOffsets.get(ack.path)
          if (prev === undefined || ack.offset > prev) {
            ackedOffsets.set(ack.path, ack.offset)
          }
        }
      }
    }

    // Reset tracking on new epoch
    if (event.type === `epoch_acquired`) {
      appendedOffsets.clear()
      ackedOffsets.clear()
    }

    // Trigger: release_response(ok)
    if (event.type === `release_response` && event.ok && consumerId) {
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

      // Scan suffix for wake_event_received before next epoch_acquired
      for (let j = i + 1; j < history.length; j++) {
        const future = history[j]!
        if (
          future.type === `wake_event_received` &&
          future.consumer_id === consumerId
        ) {
          break
        }
        if (
          future.type === `epoch_acquired` &&
          future.consumer_id === consumerId
        ) {
          throw new Error(
            `PW-L3: release_response(ok) at index ${i} with un-acked ` +
              `events for consumer '${consumerId}', but no ` +
              `wake_event_received preceded the next epoch_acquired`
          )
        }
      }
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function pullWake(
  baseUrl: string,
  wakeStreamPath: string
): PullWakeScenario {
  return new PullWakeScenario(baseUrl, wakeStreamPath)
}

/**
 * OpenTelemetry tracing primitives for the webhook consumer state machine.
 *
 * All tracing is no-op when no OTel SDK is configured.
 */

import { SpanStatusCode, propagation, trace } from "@opentelemetry/api"
import type { Context, Span, Tracer } from "@opentelemetry/api"
import type { ConsumerState } from "./webhook-types"

export const tracer: Tracer = trace.getTracer(`durable-streams.webhook`)

// Span names
export const SPAN_WAKE_CYCLE = `consumer.wake_cycle`
export const SPAN_WEBHOOK_DELIVER = `webhook.deliver`
export const SPAN_CONSUMER_CALLBACK = `consumer.callback`

// Attribute keys
export const ATTR = {
  CONSUMER_ID: `durable_streams.consumer_id`,
  SUBSCRIPTION_ID: `durable_streams.subscription_id`,
  PRIMARY_STREAM: `durable_streams.primary_stream`,
  EPOCH: `durable_streams.epoch`,
  WAKE_ID: `durable_streams.wake_id`,
  TRIGGERED_BY: `durable_streams.triggered_by`,
  RETRY_COUNT: `durable_streams.retry_count`,
  CALLBACK_ACTION: `durable_streams.callback_action`,
} as const

// Event names
export const EVENT = {
  STATE_TRANSITION: `state_transition`,
  RETRY_SCHEDULED: `retry_scheduled`,
  LIVENESS_TIMEOUT: `liveness_timeout`,
  TOKEN_REFRESHED: `token_refreshed`,
  WAKE_CLAIMED: `wake_claimed`,
  ACKS_PROCESSED: `acks_processed`,
  DONE_RECEIVED: `done_received`,
  DONE_WITH_REWAKE: `done_with_rewake`,
  CONSUMER_GC: `consumer.gc`,
  SERVER_SHUTDOWN: `server.shutdown`,
} as const

/**
 * Inject W3C traceparent into outgoing HTTP headers.
 */
export function injectTraceHeaders(
  ctx: Context,
  headers: Record<string, string>
): void {
  propagation.inject(ctx, headers)
}

/**
 * Record a state_transition event on a span.
 */
export function recordStateTransition(
  span: Span,
  from: ConsumerState,
  to: ConsumerState
): void {
  span.addEvent(EVENT.STATE_TRANSITION, { from, to })
}

/**
 * End a wake cycle span, optionally with an error status.
 */
export function endWakeCycleSpan(
  span: Span,
  eventName?: string,
  error?: boolean
): void {
  if (eventName) {
    span.addEvent(eventName)
  }
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
  span.end()
}

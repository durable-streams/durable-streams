/**
 * Types for webhook subscriptions (Layer 2).
 * L2 owns webhook delivery orchestration; L1 consumer state is managed by ConsumerManager.
 */

import type { Context, Span } from "@opentelemetry/api"

export interface Subscription {
  subscription_id: string
  pattern: string
  webhook: string
  webhook_secret: string
  description?: string
  internal?: boolean
}

/**
 * L2 webhook consumer — references an L1 consumer by consumer_id.
 * Owns only webhook delivery state; epoch, stream offsets, and liveness
 * are managed by L1 ConsumerManager.
 */
export interface WebhookConsumer {
  consumer_id: string // Reference to L1 consumer
  subscription_id: string
  primary_stream: string
  // Webhook delivery state (L2 only)
  wake_id: string | null
  wake_id_claimed: boolean
  last_webhook_failure_at: number | null
  first_webhook_failure_at: number | null
  retry_count: number
  retry_timer: ReturnType<typeof setTimeout> | null
  // Telemetry
  wake_cycle_span: Span | null
  wake_cycle_ctx: Context | null
}

export interface CallbackRequest {
  epoch: number
  wakeId?: string
  acks?: Array<{ path: string; offset: string }>
  subscribe?: Array<string>
  unsubscribe?: Array<string>
  done?: boolean
}

export interface CallbackSuccess {
  ok: true
  claimToken: string
  token?: string
  streams: Array<{ path: string; offset: string }>
  writeToken?: string
}

export interface CallbackError {
  ok: false
  error: {
    code: CallbackErrorCode
    message: string
  }
  claimToken?: string
  token?: string
}

export type CallbackErrorCode =
  | `INVALID_REQUEST`
  | `TOKEN_EXPIRED`
  | `TOKEN_INVALID`
  | `ALREADY_CLAIMED`
  | `INVALID_OFFSET`
  | `STALE_EPOCH`
  | `CONSUMER_GONE`

export type CallbackResponse = CallbackSuccess | CallbackError

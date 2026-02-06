/**
 * Types for webhook subscriptions.
 */

export interface Subscription {
  subscription_id: string
  pattern: string
  webhook: string
  webhook_secret: string
  description?: string
  internal?: boolean
}

export type ConsumerState = `IDLE` | `WAKING` | `LIVE`

export interface ConsumerInstance {
  consumer_id: string
  subscription_id: string
  primary_stream: string
  state: ConsumerState
  epoch: number
  wake_id: string | null
  wake_id_claimed: boolean
  streams: Map<string, string> // path -> last acked offset
  last_callback_at: number
  last_webhook_failure_at: number | null
  first_webhook_failure_at: number | null
  retry_count: number
  retry_timer: ReturnType<typeof setTimeout> | null
  liveness_timer: ReturnType<typeof setTimeout> | null
}

export interface CallbackRequest {
  epoch: number
  wake_id?: string
  acks?: Array<{ path: string; offset: string }>
  subscribe?: Array<string>
  unsubscribe?: Array<string>
  done?: boolean
}

export interface CallbackSuccess {
  ok: true
  token: string
  streams: Array<{ path: string; offset: string }>
}

export interface CallbackError {
  ok: false
  error: {
    code: CallbackErrorCode
    message: string
  }
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

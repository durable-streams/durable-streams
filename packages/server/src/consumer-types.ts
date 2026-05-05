/**
 * Types for Layer 1: Named Consumers.
 * L1 is mechanism-independent — no references to webhooks, push, or any L2 concept.
 */

export type ConsumerState = `REGISTERED` | `READING`

export type WakePreference =
  | { type: `none` }
  | { type: `webhook`; url: string }
  | { type: `pull-wake`; wake_stream: string }

export interface Consumer {
  consumer_id: string
  state: ConsumerState
  epoch: number
  token: string | null
  streams: Map<string, string> // path -> last acked offset
  namespace: string | null // glob pattern, e.g. "/orders/*"
  lease_ttl_ms: number
  last_ack_at: number // reset by both cursor-advancing acks and empty acks (heartbeat shape)
  lease_timer: ReturnType<typeof setTimeout> | null
  created_at: number
  wake_preference: WakePreference
  holder_id: string | null // who holds the epoch (worker id for pull-wake, null = no tracking)
}

export interface AckRequest {
  offsets: Array<{ path: string; offset: string }>
}

export interface AckResponse {
  ok: true
}

export interface AcquireResponse {
  consumer_id: string
  epoch: number
  token: string
  streams: Array<{ path: string; offset: string }>
  worker?: string
}

export interface ReleaseResponse {
  ok: true
  state: `REGISTERED`
}

export interface ConsumerInfo {
  consumer_id: string
  state: ConsumerState
  epoch: number
  streams: Array<{ path: string; offset: string }>
  namespace: string | null
  lease_ttl_ms: number
  wake_preference: WakePreference
}

export type ConsumerErrorCode =
  | `CONSUMER_NOT_FOUND`
  | `CONSUMER_ALREADY_EXISTS`
  | `EPOCH_HELD` // Reserved for future multi-server contention. Not produced by the single-process reference server.
  | `STALE_EPOCH`
  | `TOKEN_EXPIRED`
  | `TOKEN_INVALID`
  | `OFFSET_REGRESSION`
  | `INVALID_OFFSET`
  | `UNKNOWN_STREAM`
  | `INTERNAL_ERROR`

export interface ConsumerError {
  code: ConsumerErrorCode
  message: string
  current_epoch?: number
  path?: string
  retry_after?: number // seconds, for EPOCH_HELD
  holder?: string
}

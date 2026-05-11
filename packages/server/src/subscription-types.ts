export type SubscriptionType = `webhook` | `pull-wake`
export type SubscriptionStatus = `active` | `failed`
export type SubscriptionLinkType = `glob` | `explicit`

export interface SubscriptionStreamLink {
  path: string
  link_types: Set<SubscriptionLinkType>
  acked_offset: string
}

export interface SubscriptionWebhookConfig {
  url: string
  secret: string
}

export interface SubscriptionRecord {
  id: string
  type: SubscriptionType
  pattern?: string
  webhook?: SubscriptionWebhookConfig
  wake_stream?: string
  lease_ttl_ms: number
  description?: string
  created_at: string
  status: SubscriptionStatus
  config_hash: string
  streams: Map<string, SubscriptionStreamLink>
  generation: number
  wake_id: string | null
  wake_snapshot: Map<string, string>
  token: string | null
  holder: string | null
  lease_timer: ReturnType<typeof setTimeout> | null
  retry_count: number
  retry_timer: ReturnType<typeof setTimeout> | null
  next_attempt_at: number | null
}

export interface SubscriptionStreamInfo {
  path: string
  link_type: SubscriptionLinkType
  acked_offset: string
  tail_offset: string
  has_pending: boolean
}

export interface SubscriptionCreateInput {
  type: SubscriptionType
  pattern?: string
  streams: Array<string>
  webhook?: { url: string }
  wake_stream?: string
  lease_ttl_ms: number
  description?: string
}

export interface SubscriptionCallbackRequest {
  wake_id?: string
  generation?: number
  acks?: Array<{ stream?: string; path?: string; offset: string }>
  done?: boolean
}

export type SubscriptionErrorCode =
  | `INVALID_REQUEST`
  | `SUBSCRIPTION_NOT_FOUND`
  | `SUBSCRIPTION_ALREADY_EXISTS`
  | `WEBHOOK_URL_REJECTED`
  | `TOKEN_INVALID`
  | `TOKEN_EXPIRED`
  | `FENCED`
  | `ALREADY_CLAIMED`
  | `NO_PENDING_WORK`
  | `INVALID_OFFSET`

export interface SubscriptionError {
  code: SubscriptionErrorCode
  message: string
  current_holder?: string
  generation?: number
}

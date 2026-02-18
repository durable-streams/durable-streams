/**
 * Storage interface for durable stream backends.
 *
 * Implementors handle: storing bytes, reading bytes from offset,
 * computing offsets (opaque, lexicographically sortable strings),
 * notifying waiters when new data arrives, and stream metadata CRUD.
 *
 * Implementors do NOT handle: producer validation/dedup, JSON processing,
 * content-type matching, Stream-Seq coordination, closedBy tracking,
 * or long-poll timeout management.
 */

export interface StoreConfig {
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
}

export interface SerializableProducerState {
  epoch: number
  lastSeq: number
  lastUpdated: number
}

export interface ClosedByInfo {
  producerId: string
  epoch: number
  seq: number
}

export interface StreamInfo {
  contentType?: string
  currentOffset: string
  createdAt: number
  ttlSeconds?: number
  expiresAt?: string
  closed: boolean
  lastSeq?: string
  producers?: Record<string, SerializableProducerState>
  closedBy?: ClosedByInfo
}

export interface StoredMessage {
  data: Uint8Array
  offset: string
}

export interface AppendMetadata {
  lastSeq?: string
  closed?: boolean
  producers?: Record<string, SerializableProducerState>
  closedBy?: ClosedByInfo
}

export interface Store {
  create: (path: string, config: StoreConfig) => Promise<boolean>
  head: (path: string) => Promise<StreamInfo | undefined>
  delete: (path: string) => Promise<boolean>
  append: (
    path: string,
    data: Uint8Array,
    metadata?: AppendMetadata
  ) => Promise<string>
  read: (
    path: string,
    offset?: string
  ) => Promise<{ messages: Array<StoredMessage>; currentOffset: string }>
  waitForData: (
    path: string,
    offset: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<{ messages: Array<StoredMessage>; timedOut: boolean }>
  update: (
    path: string,
    updates: {
      closed?: boolean
      lastSeq?: string
      producers?: Record<string, SerializableProducerState>
      closedBy?: ClosedByInfo
    }
  ) => Promise<void>
  clear: () => void
  close: () => Promise<void>
}

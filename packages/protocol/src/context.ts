/**
 * StreamContext implementation that provides scoped access to streams within a namespace.
 */

import type {
  StreamContext,
  StreamInfo,
  CreateStreamOptions,
  AppendOptions,
  ReadOptions,
  ReadResult,
  StreamMessage,
} from "./types"

/**
 * Interface for the underlying store (matches StreamStore/FileBackedStreamStore).
 */
export interface StoreAdapter {
  create(
    path: string,
    options?: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
    }
  ): { currentOffset: string; contentType?: string; createdAt: number } | Promise<{ currentOffset: string; contentType?: string; createdAt: number }>

  get(path: string): { path: string; currentOffset: string; contentType?: string; createdAt: number; ttlSeconds?: number; expiresAt?: string } | undefined

  has(path: string): boolean

  append(
    path: string,
    data: Uint8Array,
    options?: { seq?: string; contentType?: string }
  ): StreamMessage | Promise<StreamMessage>

  read(
    path: string,
    offset?: string
  ): { messages: StreamMessage[]; upToDate: boolean }

  delete(path: string): boolean | void

  list(): string[]

  waitForMessages(
    path: string,
    offset: string,
    timeoutMs: number
  ): Promise<{ messages: StreamMessage[]; timedOut: boolean }>
}

/**
 * Options for creating a ScopedStreamContext.
 */
export interface ScopedStreamContextOptions {
  /** The namespace to scope operations to */
  namespace: string

  /** The underlying store adapter */
  store: StoreAdapter

  /** Optional callback when a stream is created */
  onStreamCreated?: (info: StreamInfo) => void | Promise<void>

  /** Optional callback when a stream is deleted */
  onStreamDeleted?: (path: string) => void | Promise<void>
}

/**
 * Normalizes a namespace path.
 * Ensures it starts with "/" and doesn't end with "/".
 */
function normalizeNamespace(namespace: string): string {
  let normalized = namespace.trim()
  if (!normalized.startsWith(`/`)) {
    normalized = `/` + normalized
  }
  if (normalized.endsWith(`/`) && normalized.length > 1) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/**
 * Normalizes a subpath and combines it with the namespace.
 */
function resolvePath(namespace: string, subpath: string): string {
  // Ensure subpath starts with /
  let normalizedSubpath = subpath.trim()
  if (!normalizedSubpath.startsWith(`/`)) {
    normalizedSubpath = `/` + normalizedSubpath
  }

  // Combine namespace and subpath
  return namespace + normalizedSubpath
}

/**
 * Validates that a full path is within the namespace.
 */
function validatePathInNamespace(namespace: string, fullPath: string): void {
  if (!fullPath.startsWith(namespace + `/`) && fullPath !== namespace) {
    throw new Error(
      `Path "${fullPath}" is outside namespace "${namespace}"`
    )
  }
}

/**
 * Converts store stream data to StreamInfo.
 */
function toStreamInfo(
  stream: {
    path: string
    currentOffset: string
    contentType?: string
    createdAt: number
    ttlSeconds?: number
    expiresAt?: string
  }
): StreamInfo {
  return {
    path: stream.path,
    contentType: stream.contentType,
    currentOffset: stream.currentOffset,
    createdAt: stream.createdAt,
    ttlSeconds: stream.ttlSeconds,
    expiresAt: stream.expiresAt,
  }
}

/**
 * Encodes data for storage.
 */
function encodeData(data: Uint8Array | string | object): Uint8Array {
  if (data instanceof Uint8Array) {
    return data
  }
  if (typeof data === `string`) {
    return new TextEncoder().encode(data)
  }
  return new TextEncoder().encode(JSON.stringify(data))
}

/**
 * Stream context that scopes all operations to a specific namespace.
 * This is the primary interface protocols use to interact with streams.
 */
export class ScopedStreamContext implements StreamContext {
  readonly namespace: string
  private readonly store: StoreAdapter
  private readonly onStreamCreated?: (info: StreamInfo) => void | Promise<void>
  private readonly onStreamDeleted?: (path: string) => void | Promise<void>

  constructor(options: ScopedStreamContextOptions) {
    this.namespace = normalizeNamespace(options.namespace)
    this.store = options.store
    this.onStreamCreated = options.onStreamCreated
    this.onStreamDeleted = options.onStreamDeleted
  }

  async create(
    subpath: string,
    options: CreateStreamOptions = {}
  ): Promise<StreamInfo> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    // Prepare initial data
    let initialData: Uint8Array | undefined
    if (options.initialData !== undefined) {
      initialData = encodeData(options.initialData)
    }

    // Create the stream
    const result = await Promise.resolve(
      this.store.create(fullPath, {
        contentType: options.contentType ?? `application/json`,
        ttlSeconds: options.ttlSeconds,
        expiresAt: options.expiresAt,
        initialData,
      })
    )

    const info: StreamInfo = {
      path: fullPath,
      contentType: result.contentType ?? options.contentType ?? `application/json`,
      currentOffset: result.currentOffset,
      createdAt: result.createdAt,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
    }

    // Fire callback
    if (this.onStreamCreated) {
      await Promise.resolve(this.onStreamCreated(info))
    }

    return info
  }

  async get(subpath: string): Promise<StreamInfo | undefined> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    const stream = this.store.get(fullPath)
    if (!stream) {
      return undefined
    }

    return toStreamInfo(stream)
  }

  async has(subpath: string): Promise<boolean> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    return this.store.has(fullPath)
  }

  async append(
    subpath: string,
    data: Uint8Array | string | object,
    options: AppendOptions = {}
  ): Promise<StreamMessage> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    const stream = this.store.get(fullPath)
    if (!stream) {
      throw new Error(`Stream not found: ${fullPath}`)
    }

    const encodedData = encodeData(data)

    return Promise.resolve(
      this.store.append(fullPath, encodedData, {
        seq: options.seq,
        contentType: stream.contentType,
      })
    )
  }

  async read(
    subpath: string,
    options: ReadOptions = {}
  ): Promise<ReadResult> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    const stream = this.store.get(fullPath)
    if (!stream) {
      throw new Error(`Stream not found: ${fullPath}`)
    }

    const { messages, upToDate } = this.store.read(fullPath, options.offset)

    // Determine the next offset
    const lastMessage = messages[messages.length - 1]
    const nextOffset = lastMessage?.offset ?? stream.currentOffset

    return {
      messages,
      nextOffset,
      upToDate,
    }
  }

  async delete(subpath: string): Promise<void> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    if (!this.store.has(fullPath)) {
      throw new Error(`Stream not found: ${fullPath}`)
    }

    this.store.delete(fullPath)

    // Fire callback
    if (this.onStreamDeleted) {
      await Promise.resolve(this.onStreamDeleted(fullPath))
    }
  }

  async list(prefix?: string): Promise<StreamInfo[]> {
    const allPaths = this.store.list()

    // Filter to streams within namespace (and optional prefix)
    const namespacePrefix = prefix
      ? resolvePath(this.namespace, prefix)
      : this.namespace + `/`

    const matchingPaths = allPaths.filter((path) =>
      path.startsWith(namespacePrefix)
    )

    return matchingPaths
      .map((path) => this.store.get(path))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map(toStreamInfo)
  }

  async waitForMessages(
    subpath: string,
    offset: string,
    timeout: number
  ): Promise<{ messages: StreamMessage[]; timedOut: boolean }> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    return this.store.waitForMessages(fullPath, offset, timeout)
  }

  async compact(
    subpath: string,
    compactor: (messages: StreamMessage[]) => Uint8Array | string | object
  ): Promise<{ oldStream: StreamInfo; newStream: StreamInfo } | undefined> {
    const fullPath = resolvePath(this.namespace, subpath)
    validatePathInNamespace(this.namespace, fullPath)

    // Get the existing stream
    const oldStreamData = this.store.get(fullPath)
    if (!oldStreamData) {
      throw new Error(`Stream not found: ${fullPath}`)
    }

    // Read all messages
    const { messages } = this.store.read(fullPath, `-1`)

    // Check if compaction is needed (at least 2 messages)
    if (messages.length < 2) {
      return undefined
    }

    // Generate compacted data
    const compactedData = compactor(messages)
    const encodedData = encodeData(compactedData)

    // Create new stream path with compaction suffix
    const timestamp = Date.now()
    const newPath = `${fullPath}~compacted~${timestamp}`

    // Create the new compacted stream
    const newStreamResult = await Promise.resolve(
      this.store.create(newPath, {
        contentType: oldStreamData.contentType,
        ttlSeconds: oldStreamData.ttlSeconds,
        expiresAt: oldStreamData.expiresAt,
        initialData: encodedData,
      })
    )

    const oldStream = toStreamInfo(oldStreamData)
    const newStream: StreamInfo = {
      path: newPath,
      contentType: oldStreamData.contentType,
      currentOffset: newStreamResult.currentOffset,
      createdAt: newStreamResult.createdAt,
      ttlSeconds: oldStreamData.ttlSeconds,
      expiresAt: oldStreamData.expiresAt,
    }

    // Fire callback for new stream
    if (this.onStreamCreated) {
      await Promise.resolve(this.onStreamCreated(newStream))
    }

    return { oldStream, newStream }
  }
}

/**
 * Create a stream context for a given namespace.
 */
export function createStreamContext(
  options: ScopedStreamContextOptions
): StreamContext {
  return new ScopedStreamContext(options)
}

/**
 * DurableFilesystem - A shared filesystem for AI agents
 *
 * Provides filesystem semantics on top of durable streams.
 */

import { DurableStream, FetchError } from "@durable-streams/client"
import {
  DirectoryNotEmptyError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  PatchApplicationError,
  PreconditionFailedError,
  isFileMetadata,
} from "./types"
import {
  applyPatch,
  basename,
  calculateChecksum,
  createPatch,
  decodeBase64,
  detectContentType,
  detectMimeType,
  dirname,
  encodeBase64,
  generateContentStreamId,
  normalizePath,
  now,
} from "./utils"
import { metadataStateSchema } from "./metadata-state"
import type {
  ContentEvent,
  ContentType,
  CreateFileOptions,
  DirectoryMetadata,
  DurableFilesystemOptions,
  Entry,
  FileMetadata,
  Metadata,
  Stat,
  WatchEvent,
  WatchEventType,
  WatchOptions,
  Watcher,
} from "./types"
import type { ChangeEvent } from "@durable-streams/state"

export { METADATA_COLLECTION_TYPE } from "./metadata-state"

const metadataEvents = metadataStateSchema.metadata

type WatchListenerMap = Map<
  string,
  Array<(...args: Array<any>) => void | Promise<void>>
>

class WatcherImpl implements Watcher {
  private readonly listeners: WatchListenerMap = new Map()
  private readonly pathFilter: string | undefined
  private readonly recursive: boolean
  private ready = false
  private _closed = false
  private closedResolve!: () => void
  readonly closed: Promise<void>

  constructor(
    private readonly removeWatcher: (w: WatcherImpl) => void,
    options?: WatchOptions
  ) {
    this.pathFilter = options?.path ? normalizePath(options.path) : undefined
    this.recursive = options?.recursive ?? true
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve
    })
    if (options?.signal) {
      options.signal.addEventListener(`abort`, () => this.close(), {
        once: true,
      })
    }
  }

  on(event: string, cb: (...args: Array<any>) => void | Promise<void>): this {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
    return this
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    this.removeWatcher(this)
    this.listeners.clear()
    this.closedResolve()
  }

  emit(watchEvent: WatchEvent): void {
    if (this._closed) return
    if (!this.matchesFilter(watchEvent.path)) return

    const specific = this.listeners.get(watchEvent.eventType)
    if (specific) {
      for (const cb of specific) {
        cb(watchEvent.path, watchEvent.metadata)
      }
    }

    const all = this.listeners.get(`all`)
    if (all) {
      for (const cb of all) {
        cb(watchEvent.eventType, watchEvent.path, watchEvent.metadata)
      }
    }
  }

  markReady(): void {
    if (this.ready || this._closed) return
    this.ready = true
    const cbs = this.listeners.get(`ready`)
    if (cbs) {
      for (const cb of cbs) {
        cb()
      }
    }
  }

  emitError(error: Error): void {
    const cbs = this.listeners.get(`error`)
    if (cbs) {
      for (const cb of cbs) {
        cb(error)
      }
    }
  }

  private matchesFilter(eventPath: string): boolean {
    if (!this.pathFilter) return true

    if (this.pathFilter === eventPath) return true

    const prefix = this.pathFilter === `/` ? `/` : `${this.pathFilter}/`
    if (eventPath.startsWith(prefix)) {
      if (this.recursive) return true
      const remainder = eventPath.slice(prefix.length)
      return !remainder.includes(`/`)
    }

    return false
  }
}

export class DurableFilesystem {
  private readonly baseUrl: string
  readonly streamPrefix: string
  private readonly headers?: Record<string, string>

  private readonly files = new Map<string, FileMetadata>()
  private readonly directories = new Map<string, DirectoryMetadata>()

  private readonly contentCache = new Map<string, string>()

  private metadataStream: DurableStream | null = null
  private readonly contentStreams = new Map<string, DurableStream>()

  private _metadataOffset = `-1`
  private readonly contentOffsets = new Map<string, string>()

  private readonly activeWatchers = new Set<WatcherImpl>()
  private sseUnsubscribe: (() => void) | null = null

  private readonly readSnapshots = new Map<string, FileMetadata>()

  get metadataOffset(): string {
    return this._metadataOffset
  }

  private initialized = false

  constructor(options: DurableFilesystemOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ``)
    this.streamPrefix = options.streamPrefix.startsWith(`/`)
      ? options.streamPrefix
      : `/${options.streamPrefix}`
    this.headers = options.headers
  }

  private buildStreamUrl(streamPath: string): string {
    const path = streamPath.startsWith(`/`) ? streamPath : `/${streamPath}`
    return `${this.baseUrl}${this.streamPrefix}${path}`
  }

  private getOrCreateContentStream(streamId: string): DurableStream {
    let stream = this.contentStreams.get(streamId)
    if (!stream) {
      stream = new DurableStream({
        url: this.buildStreamUrl(`/_content/${streamId}`),
        headers: this.headers,
        contentType: `application/json`,
      })
      this.contentStreams.set(streamId, stream)
    }
    return stream
  }

  // Lifecycle

  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    const metadataUrl = this.buildStreamUrl(`/_metadata`)

    try {
      this.metadataStream = await DurableStream.connect({
        url: metadataUrl,
        headers: this.headers,
        contentType: `application/json`,
      })
    } catch (err) {
      if (err instanceof FetchError && err.status === 404) {
        this.metadataStream = await DurableStream.create({
          url: metadataUrl,
          headers: this.headers,
          contentType: `application/json`,
        })
      } else {
        throw err
      }
    }

    await this.refreshMetadata()

    if (!this.directories.has(`/`)) {
      const rootMeta: DirectoryMetadata = {
        type: `directory`,
        createdAt: now(),
        modifiedAt: now(),
      }
      await this.appendMetadata(
        metadataEvents.insert({ value: { path: `/`, ...rootMeta } })
      )
      this.directories.set(`/`, rootMeta)
    }

    this.initialized = true
  }

  close(): void {
    for (const watcher of this.activeWatchers) {
      watcher.close()
    }
    this.activeWatchers.clear()
    this.stopSSESubscription()
    this.readSnapshots.clear()
    this.metadataStream = null
    this.contentStreams.clear()
    this.contentCache.clear()
    this.initialized = false
  }

  // File Operations

  async createFile(
    path: string,
    content: string | Uint8Array,
    options?: CreateFileOptions
  ): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (
      this.files.has(normalizedPath) ||
      this.directories.has(normalizedPath)
    ) {
      throw new ExistsError(normalizedPath)
    }

    const parentPath = dirname(normalizedPath)
    if (!this.directories.has(parentPath)) {
      throw new NotFoundError(parentPath)
    }

    const isText =
      typeof content === `string` ||
      (content instanceof Uint8Array &&
        detectContentType(detectMimeType(normalizedPath)) === `text`)
    const contentType: ContentType =
      options?.contentType ?? (isText ? `text` : `binary`)
    const mimeType = options?.mimeType ?? detectMimeType(normalizedPath)

    let contentStr: string
    let size: number

    if (typeof content === `string`) {
      contentStr = content
      size = new TextEncoder().encode(content).length
    } else if (contentType === `text`) {
      contentStr = new TextDecoder().decode(content)
      size = content.length
    } else {
      contentStr = encodeBase64(content)
      size = content.length
    }

    const contentStreamId = generateContentStreamId()
    const contentUrl = this.buildStreamUrl(`/_content/${contentStreamId}`)
    const contentStream = await DurableStream.create({
      url: contentUrl,
      headers: this.headers,
      contentType: `application/json`,
    })
    this.contentStreams.set(contentStreamId, contentStream)

    const checksum = await calculateChecksum(contentStr)
    const initEvent: ContentEvent =
      contentType === `binary`
        ? { op: `replace`, content: contentStr, encoding: `base64`, checksum }
        : { op: `init`, content: contentStr, checksum }

    await contentStream.append(JSON.stringify(initEvent))

    const headResult = await contentStream.head()
    this.contentOffsets.set(contentStreamId, headResult.offset ?? `-1`)
    this.contentCache.set(contentStreamId, contentStr)

    const timestamp = now()
    const fileMeta: FileMetadata = {
      type: `file`,
      contentStreamId,
      contentType,
      mimeType,
      size,
      createdAt: timestamp,
      modifiedAt: timestamp,
    }

    try {
      await this.appendMetadata(
        metadataEvents.insert({ value: { path: normalizedPath, ...fileMeta } })
      )
      this.files.set(normalizedPath, fileMeta)
    } catch (err) {
      this.contentStreams.delete(contentStreamId)
      this.contentOffsets.delete(contentStreamId)
      this.contentCache.delete(contentStreamId)
      throw err
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.getFileMeta(normalizedPath)
    this.checkStaleWrite(normalizedPath, fileMeta)
    const contentStream = this.getOrCreateContentStream(
      fileMeta.contentStreamId
    )

    let contentStr: string
    let size: number

    if (typeof content === `string`) {
      contentStr = content
      size = new TextEncoder().encode(content).length
    } else if (fileMeta.contentType === `text`) {
      contentStr = new TextDecoder().decode(content)
      size = content.length
    } else {
      contentStr = encodeBase64(content)
      size = content.length
    }

    const previousContent = this.contentCache.get(fileMeta.contentStreamId)
    const previousOffset = this.contentOffsets.get(fileMeta.contentStreamId)

    let event: ContentEvent

    if (fileMeta.contentType === `text`) {
      const currentContent = await this.getFileContent(fileMeta.contentStreamId)
      const patch = createPatch(currentContent, contentStr)
      const checksum = await calculateChecksum(contentStr)

      if (patch.length < contentStr.length * 0.9) {
        event = { op: `patch`, patch, checksum }
      } else {
        event = { op: `replace`, content: contentStr, checksum }
      }
    } else {
      const checksum = await calculateChecksum(contentStr)
      event = {
        op: `replace`,
        content: contentStr,
        encoding: `base64`,
        checksum,
      }
    }

    await contentStream.append(JSON.stringify(event))

    const headResult = await contentStream.head()
    this.contentOffsets.set(fileMeta.contentStreamId, headResult.offset ?? `-1`)
    this.contentCache.set(fileMeta.contentStreamId, contentStr)

    const updatedMeta: FileMetadata = {
      ...fileMeta,
      size,
      modifiedAt: now(),
    }
    try {
      await this.appendMetadata(
        metadataEvents.update({
          value: { path: normalizedPath, ...updatedMeta },
        })
      )
      this.files.set(normalizedPath, updatedMeta)
      this.readSnapshots.set(normalizedPath, { ...updatedMeta })
    } catch (err) {
      if (previousContent !== undefined) {
        try {
          const oldChecksum = await calculateChecksum(previousContent)
          await contentStream.append(
            JSON.stringify({
              op: `replace`,
              content: previousContent,
              checksum: oldChecksum,
            })
          )
        } catch {
          /* best-effort compensation */
        }
      }
      if (previousContent !== undefined)
        this.contentCache.set(fileMeta.contentStreamId, previousContent)
      else this.contentCache.delete(fileMeta.contentStreamId)
      if (previousOffset !== undefined)
        this.contentOffsets.set(fileMeta.contentStreamId, previousOffset)
      else this.contentOffsets.delete(fileMeta.contentStreamId)
      throw err
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.getFileMeta(normalizedPath)
    const content = await this.getFileContent(fileMeta.contentStreamId)
    this.readSnapshots.set(normalizedPath, { ...fileMeta })

    if (fileMeta.contentType === `binary`) {
      return decodeBase64(content)
    }

    return new TextEncoder().encode(content)
  }

  async readTextFile(path: string): Promise<string> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.getFileMeta(normalizedPath)

    if (fileMeta.contentType === `binary`) {
      throw new Error(`Cannot read binary file as text: ${normalizedPath}`)
    }

    const content = await this.getFileContent(fileMeta.contentStreamId)
    this.readSnapshots.set(normalizedPath, { ...fileMeta })
    return content
  }

  async deleteFile(path: string): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.getFileMeta(normalizedPath)

    await this.appendMetadata(metadataEvents.delete({ key: normalizedPath }))
    this.files.delete(normalizedPath)
    this.readSnapshots.delete(normalizedPath)

    try {
      const contentUrl = this.buildStreamUrl(
        `/_content/${fileMeta.contentStreamId}`
      )
      await DurableStream.delete({ url: contentUrl, headers: this.headers })
    } catch {
      /* orphaned content stream is harmless */
    }
    this.contentStreams.delete(fileMeta.contentStreamId)
    this.contentCache.delete(fileMeta.contentStreamId)
    this.contentOffsets.delete(fileMeta.contentStreamId)
  }

  async applyTextPatch(path: string, patch: string): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.getFileMeta(normalizedPath)
    this.checkStaleWrite(normalizedPath, fileMeta)

    if (fileMeta.contentType !== `text`) {
      throw new Error(
        `Cannot apply text patch to binary file: ${normalizedPath}`
      )
    }

    const contentStream = this.getOrCreateContentStream(
      fileMeta.contentStreamId
    )
    const currentContent = await this.getFileContent(fileMeta.contentStreamId)
    const previousOffset = this.contentOffsets.get(fileMeta.contentStreamId)

    let newContent: string
    try {
      newContent = applyPatch(currentContent, patch)
    } catch (err) {
      throw new PatchApplicationError(
        normalizedPath,
        `patch failed`,
        `Failed to apply patch: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const checksum = await calculateChecksum(newContent)
    const event: ContentEvent = { op: `patch`, patch, checksum }

    await contentStream.append(JSON.stringify(event))

    const headResult = await contentStream.head()
    this.contentOffsets.set(fileMeta.contentStreamId, headResult.offset ?? `-1`)
    this.contentCache.set(fileMeta.contentStreamId, newContent)

    const newSize = new TextEncoder().encode(newContent).length
    const updatedMeta: FileMetadata = {
      ...fileMeta,
      size: newSize,
      modifiedAt: now(),
    }
    try {
      await this.appendMetadata(
        metadataEvents.update({
          value: { path: normalizedPath, ...updatedMeta },
        })
      )
      this.files.set(normalizedPath, updatedMeta)
      this.readSnapshots.set(normalizedPath, { ...updatedMeta })
    } catch (err) {
      try {
        const oldChecksum = await calculateChecksum(currentContent)
        await contentStream.append(
          JSON.stringify({
            op: `replace`,
            content: currentContent,
            checksum: oldChecksum,
          })
        )
      } catch {
        /* best-effort compensation */
      }
      this.contentCache.set(fileMeta.contentStreamId, currentContent)
      if (previousOffset !== undefined)
        this.contentOffsets.set(fileMeta.contentStreamId, previousOffset)
      else this.contentOffsets.delete(fileMeta.contentStreamId)
      throw err
    }
  }

  // Directory Operations

  async mkdir(path: string): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (
      this.files.has(normalizedPath) ||
      this.directories.has(normalizedPath)
    ) {
      throw new ExistsError(normalizedPath)
    }

    const parentPath = dirname(normalizedPath)
    if (parentPath !== normalizedPath && !this.directories.has(parentPath)) {
      throw new NotFoundError(parentPath)
    }

    const timestamp = now()
    const dirMeta: DirectoryMetadata = {
      type: `directory`,
      createdAt: timestamp,
      modifiedAt: timestamp,
    }

    await this.appendMetadata(
      metadataEvents.insert({ value: { path: normalizedPath, ...dirMeta } })
    )
    this.directories.set(normalizedPath, dirMeta)
  }

  async rmdir(path: string): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (normalizedPath === `/`) {
      throw new Error(`Cannot remove root directory`)
    }

    if (!this.directories.has(normalizedPath)) {
      if (this.files.has(normalizedPath)) {
        throw new NotDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }

    const children = this.getDirectChildren(normalizedPath)
    if (children.length > 0) {
      throw new DirectoryNotEmptyError(normalizedPath)
    }

    await this.appendMetadata(metadataEvents.delete({ key: normalizedPath }))
    this.directories.delete(normalizedPath)
  }

  list(path: string): Array<Entry> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (!this.directories.has(normalizedPath)) {
      if (this.files.has(normalizedPath)) {
        throw new NotDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }

    const children = this.getDirectChildren(normalizedPath)
    return children.map((childPath) => {
      const name = basename(childPath)
      const fileMeta = this.files.get(childPath)
      if (fileMeta) {
        return {
          name,
          type: `file` as const,
          size: fileMeta.size,
          modifiedAt: fileMeta.modifiedAt,
        }
      }

      const dirMeta = this.directories.get(childPath)!
      return {
        name,
        type: `directory` as const,
        size: 0,
        modifiedAt: dirMeta.modifiedAt,
      }
    })
  }

  // Metadata Operations

  exists(path: string): boolean {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)
    return (
      this.files.has(normalizedPath) || this.directories.has(normalizedPath)
    )
  }

  isDirectory(path: string): boolean {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)
    return this.directories.has(normalizedPath)
  }

  stat(path: string): Stat {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.files.get(normalizedPath)
    if (fileMeta) {
      return {
        type: `file`,
        size: fileMeta.size,
        createdAt: fileMeta.createdAt,
        modifiedAt: fileMeta.modifiedAt,
        mimeType: fileMeta.mimeType,
        contentType: fileMeta.contentType,
      }
    }

    const dirMeta = this.directories.get(normalizedPath)
    if (dirMeta) {
      return {
        type: `directory`,
        size: 0,
        createdAt: dirMeta.createdAt,
        modifiedAt: dirMeta.modifiedAt,
      }
    }

    throw new NotFoundError(normalizedPath)
  }

  // Synchronization

  watch(options?: WatchOptions): Watcher {
    this.ensureInitialized()

    const watcher = new WatcherImpl((w) => this.removeWatcher(w), options)
    this.activeWatchers.add(watcher)

    if (!this.sseUnsubscribe) {
      this.startSSESubscription()
    }

    return watcher
  }

  // Cache Management

  evictFromCache(path: string): void {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)
    const fileMeta = this.files.get(normalizedPath)
    if (fileMeta) {
      this.contentCache.delete(fileMeta.contentStreamId)
    }
  }

  clearContentCache(): void {
    this.contentCache.clear()
  }

  // Private Methods

  private startSSESubscription(): void {
    if (!this.metadataStream) return

    this.metadataStream
      .stream<ChangeEvent>({
        live: `sse`,
        offset: this._metadataOffset,
        json: true,
      })
      .then((response) => {
        this.sseUnsubscribe = response.subscribeJson((batch) => {
          for (const event of batch.items) {
            this.handleWatchEvent(event)

            const watchEvent = this.toWatchEvent(event, batch.offset)

            this.applyMetadataEvent(event)

            for (const watcher of this.activeWatchers) {
              watcher.emit(watchEvent)
            }
          }

          this._metadataOffset = batch.offset

          if (batch.upToDate) {
            for (const watcher of this.activeWatchers) {
              watcher.markReady()
            }
          }
        })
      })
      .catch((err) => {
        for (const watcher of this.activeWatchers) {
          watcher.emitError(err instanceof Error ? err : new Error(String(err)))
        }
      })
  }

  private stopSSESubscription(): void {
    if (this.sseUnsubscribe) {
      this.sseUnsubscribe()
      this.sseUnsubscribe = null
    }
  }

  private removeWatcher(watcher: WatcherImpl): void {
    this.activeWatchers.delete(watcher)
    if (this.activeWatchers.size === 0) {
      this.stopSSESubscription()
    }
  }

  private handleWatchEvent(event: ChangeEvent): void {
    const meta = event.value as Metadata | undefined
    if (event.headers.operation === `update` && meta && isFileMetadata(meta)) {
      const oldMeta = this.files.get(event.key)
      if (oldMeta && isFileMetadata(oldMeta)) {
        this.contentCache.delete(oldMeta.contentStreamId)
        this.contentOffsets.delete(oldMeta.contentStreamId)
      }
    } else if (event.headers.operation === `delete`) {
      const oldMeta = this.files.get(event.key)
      if (oldMeta && isFileMetadata(oldMeta)) {
        this.contentCache.delete(oldMeta.contentStreamId)
        this.contentOffsets.delete(oldMeta.contentStreamId)
        this.contentStreams.delete(oldMeta.contentStreamId)
      }
    }
  }

  private toWatchEvent(event: ChangeEvent, offset: string): WatchEvent {
    const meta = event.value as Metadata | undefined
    let eventType: WatchEventType

    if (event.headers.operation === `insert`) {
      eventType = meta?.type === `directory` ? `addDir` : `add`
    } else if (event.headers.operation === `update`) {
      eventType = `change`
    } else {
      eventType = this.directories.has(event.key) ? `unlinkDir` : `unlink`
    }

    return {
      eventType,
      path: event.key,
      metadata: meta,
      offset,
    }
  }

  private applyMetadataEvent(event: ChangeEvent): void {
    if (
      event.headers.operation === `insert` ||
      event.headers.operation === `update`
    ) {
      const meta = event.value as Metadata
      if (isFileMetadata(meta)) {
        this.files.set(event.key, meta)
      } else {
        this.directories.set(event.key, meta)
      }
    } else {
      this.files.delete(event.key)
      this.directories.delete(event.key)
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`Filesystem not initialized. Call initialize() first.`)
    }
  }

  private checkStaleWrite(
    normalizedPath: string,
    currentMeta: FileMetadata
  ): void {
    const snapshot = this.readSnapshots.get(normalizedPath)
    if (snapshot && snapshot.modifiedAt !== currentMeta.modifiedAt) {
      throw new PreconditionFailedError(normalizedPath)
    }
  }

  private getFileMeta(normalizedPath: string): FileMetadata {
    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      if (this.directories.has(normalizedPath)) {
        throw new IsDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }
    return fileMeta
  }

  private getDirectChildren(parentPath: string): Array<string> {
    const prefix = parentPath === `/` ? `/` : `${parentPath}/`
    const children: Array<string> = []

    for (const path of this.files.keys()) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes(`/`)) {
        children.push(path)
      }
    }

    for (const path of this.directories.keys()) {
      if (path === parentPath) continue
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes(`/`)) {
        children.push(path)
      }
    }

    return children.sort()
  }

  private async appendMetadata(event: ChangeEvent): Promise<void> {
    if (!this.metadataStream) {
      throw new Error(`Metadata stream not initialized`)
    }

    await this.metadataStream.append(JSON.stringify(event))

    const headResult = await this.metadataStream.head()
    this._metadataOffset = headResult.offset ?? `-1`
  }

  private async refreshMetadata(): Promise<void> {
    if (!this.metadataStream) {
      throw new Error(`Metadata stream not initialized`)
    }

    const response = await this.metadataStream.stream<ChangeEvent>({
      live: false,
      offset: `-1`,
    })
    const events = await response.json()

    this._metadataOffset = response.offset

    this.files.clear()
    this.directories.clear()

    for (const event of events) {
      this.applyMetadataEvent(event)
    }
  }

  private async getFileContent(streamId: string): Promise<string> {
    const cached = this.contentCache.get(streamId)
    if (cached !== undefined) {
      return cached
    }

    const contentStream = this.getOrCreateContentStream(streamId)

    const response = await contentStream.stream<ContentEvent>({
      live: false,
      offset: `-1`,
    })
    const events = await response.json()

    this.contentOffsets.set(streamId, response.offset)

    let content = ``
    let lastChecksum: string | undefined
    for (const event of events) {
      if (event.op === `init` || event.op === `replace`) {
        content = event.content
      } else {
        try {
          content = applyPatch(content, event.patch)
        } catch (err) {
          throw new PatchApplicationError(
            streamId,
            `replay failed`,
            `Failed to replay content stream ${streamId}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      lastChecksum = event.checksum
    }

    if (lastChecksum) {
      const actual = await calculateChecksum(content)
      if (actual !== lastChecksum) {
        throw new PatchApplicationError(
          streamId,
          `checksum mismatch`,
          `Content integrity check failed for stream ${streamId}: expected ${lastChecksum}, got ${actual}`
        )
      }
    }

    this.contentCache.set(streamId, content)

    return content
  }
}

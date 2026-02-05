/**
 * DurableFilesystem - A shared filesystem for AI agents
 *
 * Provides filesystem semantics on top of durable streams.
 */

import { DurableStream } from "@durable-streams/client"
import {
  DirectoryNotEmptyError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  PatchApplicationError,
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
} from "./types"

/**
 * Metadata event format in the metadata stream
 */
interface MetadataEvent {
  type: `insert` | `update` | `delete`
  key: string
  value?: Metadata
}

/**
 * DurableFilesystem - A shared filesystem for AI agents
 */
export class DurableFilesystem {
  private readonly baseUrl: string
  readonly streamPrefix: string
  private readonly headers?: Record<string, string>

  // Materialized state
  private readonly files = new Map<string, FileMetadata>()
  private readonly directories = new Map<string, DirectoryMetadata>()

  // Content cache
  private readonly contentCache = new Map<string, string>()

  // Stream handles
  private metadataStream: DurableStream | null = null
  private readonly contentStreams = new Map<string, DurableStream>()

  // Offset tracking for OCC
  private _metadataOffset = `-1`
  private readonly contentOffsets = new Map<string, string>()

  /** Current metadata stream offset (for OCC and debugging) */
  get metadataOffset(): string {
    return this._metadataOffset
  }

  // Initialization state
  private initialized = false

  constructor(options: DurableFilesystemOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ``) // Remove trailing slash
    this.streamPrefix = options.streamPrefix.startsWith(`/`)
      ? options.streamPrefix
      : `/${options.streamPrefix}`
    this.headers = options.headers
  }

  /**
   * Build a full stream URL from a stream path
   */
  private buildStreamUrl(streamPath: string): string {
    const path = streamPath.startsWith(`/`) ? streamPath : `/${streamPath}`
    return `${this.baseUrl}${this.streamPrefix}${path}`
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Initialize the filesystem by loading metadata from the stream
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    // Create metadata stream
    const metadataUrl = this.buildStreamUrl(`/_metadata`)

    try {
      // Try to connect to existing stream
      this.metadataStream = await DurableStream.connect({
        url: metadataUrl,
        headers: this.headers,
        contentType: `application/json`,
      })
    } catch (err) {
      // Create new stream if it doesn't exist
      if (err instanceof Error && err.message.includes(`404`)) {
        this.metadataStream = await DurableStream.create({
          url: metadataUrl,
          headers: this.headers,
          contentType: `application/json`,
        })
      } else {
        throw err
      }
    }

    // Load and materialize metadata
    await this.refreshMetadata()

    // Ensure root directory exists
    if (!this.directories.has(`/`)) {
      const rootMeta: DirectoryMetadata = {
        type: `directory`,
        createdAt: now(),
        modifiedAt: now(),
      }
      await this.appendMetadata({ type: `insert`, key: `/`, value: rootMeta })
      this.directories.set(`/`, rootMeta)
    }

    this.initialized = true
  }

  /**
   * Close all stream handles
   */
  close(): void {
    // DurableStream handles don't need explicit closing
    this.metadataStream = null
    this.contentStreams.clear()
    this.contentCache.clear()
    this.initialized = false
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * Create a new file
   */
  async createFile(
    path: string,
    content: string | Uint8Array,
    options?: CreateFileOptions
  ): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    // Check if already exists
    if (
      this.files.has(normalizedPath) ||
      this.directories.has(normalizedPath)
    ) {
      throw new ExistsError(normalizedPath)
    }

    // Ensure parent directory exists
    const parentPath = dirname(normalizedPath)
    if (!this.directories.has(parentPath)) {
      throw new NotFoundError(parentPath)
    }

    // Determine content type and MIME type
    const isText =
      typeof content === `string` ||
      (content instanceof Uint8Array &&
        detectContentType(detectMimeType(normalizedPath)) === `text`)
    const contentType: ContentType =
      options?.contentType ?? (isText ? `text` : `binary`)
    const mimeType = options?.mimeType ?? detectMimeType(normalizedPath)

    // Convert content to string for storage
    let contentStr: string
    let size: number

    if (typeof content === `string`) {
      contentStr = content
      size = new TextEncoder().encode(content).length
    } else {
      if (contentType === `text`) {
        contentStr = new TextDecoder().decode(content)
        size = content.length
      } else {
        contentStr = encodeBase64(content)
        size = content.length
      }
    }

    // Create content stream
    const contentStreamId = generateContentStreamId()
    const contentUrl = this.buildStreamUrl(`/_content/${contentStreamId}`)
    const contentStream = await DurableStream.create({
      url: contentUrl,
      headers: this.headers,
      contentType: `application/json`,
    })
    this.contentStreams.set(contentStreamId, contentStream)

    // Create initial content event
    const checksum = await calculateChecksum(contentStr)
    const initEvent: ContentEvent =
      contentType === `binary`
        ? { op: `replace`, content: contentStr, encoding: `base64`, checksum }
        : { op: `init`, content: contentStr, checksum }

    await contentStream.append(JSON.stringify(initEvent))

    // Get current offset
    const headResult = await contentStream.head()
    this.contentOffsets.set(contentStreamId, headResult.offset ?? `-1`)
    this.contentCache.set(contentStreamId, contentStr)

    // Create file metadata
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

    // Append to metadata stream
    await this.appendMetadata({
      type: `insert`,
      key: normalizedPath,
      value: fileMeta,
    })
    this.files.set(normalizedPath, fileMeta)
  }

  /**
   * Write content to an existing file (full replace)
   */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      if (this.directories.has(normalizedPath)) {
        throw new IsDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }

    // Get or create content stream handle
    let contentStream = this.contentStreams.get(fileMeta.contentStreamId)
    if (!contentStream) {
      const contentUrl = this.buildStreamUrl(
        `/_content/${fileMeta.contentStreamId}`
      )
      contentStream = new DurableStream({
        url: contentUrl,
        headers: this.headers,
        contentType: `application/json`,
      })
      this.contentStreams.set(fileMeta.contentStreamId, contentStream)
    }

    // Convert content
    let contentStr: string
    let size: number

    if (typeof content === `string`) {
      contentStr = content
      size = new TextEncoder().encode(content).length
    } else {
      if (fileMeta.contentType === `text`) {
        contentStr = new TextDecoder().decode(content)
        size = content.length
      } else {
        contentStr = encodeBase64(content)
        size = content.length
      }
    }

    // Get current content for patching (text files only)
    let event: ContentEvent

    if (fileMeta.contentType === `text`) {
      const currentContent = await this.getFileContent(fileMeta.contentStreamId)
      const patch = createPatch(currentContent, contentStr)
      const checksum = await calculateChecksum(contentStr)

      // Use patch if it's smaller than full replace
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

    // Append to stream
    await contentStream.append(JSON.stringify(event))

    // Update offset
    const headResult = await contentStream.head()
    this.contentOffsets.set(fileMeta.contentStreamId, headResult.offset ?? `-1`)
    this.contentCache.set(fileMeta.contentStreamId, contentStr)

    // Update metadata
    const updatedMeta: FileMetadata = {
      ...fileMeta,
      size,
      modifiedAt: now(),
    }
    await this.appendMetadata({
      type: `update`,
      key: normalizedPath,
      value: updatedMeta,
    })
    this.files.set(normalizedPath, updatedMeta)
  }

  /**
   * Read file content as bytes
   */
  async readFile(path: string): Promise<Uint8Array> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      if (this.directories.has(normalizedPath)) {
        throw new IsDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }

    const content = await this.getFileContent(fileMeta.contentStreamId)

    if (fileMeta.contentType === `binary`) {
      return decodeBase64(content)
    }

    return new TextEncoder().encode(content)
  }

  /**
   * Read file content as text
   */
  async readTextFile(path: string): Promise<string> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      if (this.directories.has(normalizedPath)) {
        throw new IsDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }

    if (fileMeta.contentType === `binary`) {
      throw new Error(`Cannot read binary file as text: ${normalizedPath}`)
    }

    return this.getFileContent(fileMeta.contentStreamId)
  }

  /**
   * Delete a file
   */
  async deleteFile(path: string): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      if (this.directories.has(normalizedPath)) {
        throw new IsDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }

    // Delete content stream
    const contentUrl = this.buildStreamUrl(
      `/_content/${fileMeta.contentStreamId}`
    )
    await DurableStream.delete({ url: contentUrl, headers: this.headers })
    this.contentStreams.delete(fileMeta.contentStreamId)
    this.contentCache.delete(fileMeta.contentStreamId)
    this.contentOffsets.delete(fileMeta.contentStreamId)

    // Remove from metadata
    await this.appendMetadata({ type: `delete`, key: normalizedPath })
    this.files.delete(normalizedPath)
  }

  /**
   * Apply a text patch to a file
   */
  async applyTextPatch(path: string, patch: string): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      if (this.directories.has(normalizedPath)) {
        throw new IsDirectoryError(normalizedPath)
      }
      throw new NotFoundError(normalizedPath)
    }

    if (fileMeta.contentType !== `text`) {
      throw new Error(
        `Cannot apply text patch to binary file: ${normalizedPath}`
      )
    }

    // Get content stream
    let contentStream = this.contentStreams.get(fileMeta.contentStreamId)
    if (!contentStream) {
      const contentUrl = this.buildStreamUrl(
        `/_content/${fileMeta.contentStreamId}`
      )
      contentStream = new DurableStream({
        url: contentUrl,
        headers: this.headers,
        contentType: `application/json`,
      })
      this.contentStreams.set(fileMeta.contentStreamId, contentStream)
    }

    // Get current content
    const currentContent = await this.getFileContent(fileMeta.contentStreamId)

    // Apply patch locally to validate and get new content
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

    // Create patch event
    const checksum = await calculateChecksum(newContent)
    const event: ContentEvent = { op: `patch`, patch, checksum }

    // Append to stream
    await contentStream.append(JSON.stringify(event))

    // Update offset
    const headResult = await contentStream.head()
    this.contentOffsets.set(fileMeta.contentStreamId, headResult.offset ?? `-1`)
    this.contentCache.set(fileMeta.contentStreamId, newContent)

    // Update metadata
    const newSize = new TextEncoder().encode(newContent).length
    const updatedMeta: FileMetadata = {
      ...fileMeta,
      size: newSize,
      modifiedAt: now(),
    }
    await this.appendMetadata({
      type: `update`,
      key: normalizedPath,
      value: updatedMeta,
    })
    this.files.set(normalizedPath, updatedMeta)
  }

  // ============================================================================
  // Directory Operations
  // ============================================================================

  /**
   * Create a directory
   */
  async mkdir(path: string): Promise<void> {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    // Check if already exists
    if (
      this.files.has(normalizedPath) ||
      this.directories.has(normalizedPath)
    ) {
      throw new ExistsError(normalizedPath)
    }

    // Ensure parent directory exists
    const parentPath = dirname(normalizedPath)
    if (parentPath !== normalizedPath && !this.directories.has(parentPath)) {
      throw new NotFoundError(parentPath)
    }

    // Create directory metadata
    const timestamp = now()
    const dirMeta: DirectoryMetadata = {
      type: `directory`,
      createdAt: timestamp,
      modifiedAt: timestamp,
    }

    await this.appendMetadata({
      type: `insert`,
      key: normalizedPath,
      value: dirMeta,
    })
    this.directories.set(normalizedPath, dirMeta)
  }

  /**
   * Remove an empty directory
   */
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

    // Check if empty
    const children = this.getDirectChildren(normalizedPath)
    if (children.length > 0) {
      throw new DirectoryNotEmptyError(normalizedPath)
    }

    await this.appendMetadata({ type: `delete`, key: normalizedPath })
    this.directories.delete(normalizedPath)
  }

  /**
   * List directory contents
   */
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

  // ============================================================================
  // Metadata Operations
  // ============================================================================

  /**
   * Check if a path exists
   */
  exists(path: string): boolean {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)
    return (
      this.files.has(normalizedPath) || this.directories.has(normalizedPath)
    )
  }

  /**
   * Check if a path is a directory
   */
  isDirectory(path: string): boolean {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)
    return this.directories.has(normalizedPath)
  }

  /**
   * Get file or directory stats
   */
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

  // ============================================================================
  // Synchronization
  // ============================================================================

  /**
   * Refresh state from streams
   */
  async refresh(): Promise<void> {
    this.ensureInitialized()

    // Refresh metadata
    await this.refreshMetadata()

    // Clear content cache to force re-read
    this.contentCache.clear()
    this.contentOffsets.clear()
  }

  // ============================================================================
  // Cache Management
  // ============================================================================

  /**
   * Evict a file from the content cache
   */
  evictFromCache(path: string): void {
    this.ensureInitialized()
    const normalizedPath = normalizePath(path)
    const fileMeta = this.files.get(normalizedPath)
    if (fileMeta) {
      this.contentCache.delete(fileMeta.contentStreamId)
    }
  }

  /**
   * Clear all content cache
   */
  clearContentCache(): void {
    this.contentCache.clear()
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`Filesystem not initialized. Call initialize() first.`)
    }
  }

  /**
   * Get direct children of a directory path
   */
  private getDirectChildren(parentPath: string): Array<string> {
    const prefix = parentPath === `/` ? `/` : `${parentPath}/`
    const children: Array<string> = []

    // Check files
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) {
        const remainder = path.slice(prefix.length)
        // Direct child has no more slashes
        if (!remainder.includes(`/`)) {
          children.push(path)
        }
      }
    }

    // Check directories
    for (const path of this.directories.keys()) {
      if (path === parentPath) continue
      if (path.startsWith(prefix)) {
        const remainder = path.slice(prefix.length)
        if (!remainder.includes(`/`)) {
          children.push(path)
        }
      }
    }

    return children.sort()
  }

  /**
   * Append to metadata stream
   */
  private async appendMetadata(event: MetadataEvent): Promise<void> {
    if (!this.metadataStream) {
      throw new Error(`Metadata stream not initialized`)
    }

    await this.metadataStream.append(JSON.stringify(event))

    // Update offset
    const headResult = await this.metadataStream.head()
    this._metadataOffset = headResult.offset ?? `-1`
  }

  /**
   * Refresh metadata from stream
   */
  private async refreshMetadata(): Promise<void> {
    if (!this.metadataStream) {
      throw new Error(`Metadata stream not initialized`)
    }

    // Read all events
    const response = await this.metadataStream.stream<MetadataEvent>({
      live: false,
      offset: `-1`,
    })
    const events = await response.json()

    // Update offset
    this._metadataOffset = response.offset

    // Clear and rematerialize
    this.files.clear()
    this.directories.clear()

    for (const event of events) {
      if (event.type === `insert` || event.type === `update`) {
        const meta = event.value!
        if (isFileMetadata(meta)) {
          this.files.set(event.key, meta)
        } else {
          this.directories.set(event.key, meta)
        }
      } else {
        // event.type === `delete`
        this.files.delete(event.key)
        this.directories.delete(event.key)
      }
    }
  }

  /**
   * Get file content from cache or stream
   */
  private async getFileContent(streamId: string): Promise<string> {
    // Check cache first
    const cached = this.contentCache.get(streamId)
    if (cached !== undefined) {
      return cached
    }

    // Get stream handle
    let contentStream = this.contentStreams.get(streamId)
    if (!contentStream) {
      const contentUrl = this.buildStreamUrl(`/_content/${streamId}`)
      contentStream = new DurableStream({
        url: contentUrl,
        headers: this.headers,
        contentType: `application/json`,
      })
      this.contentStreams.set(streamId, contentStream)
    }

    // Read and replay events
    const response = await contentStream.stream<ContentEvent>({
      live: false,
      offset: `-1`,
    })
    const events = await response.json()

    // Update offset
    this.contentOffsets.set(streamId, response.offset)

    let content = ``
    for (const event of events) {
      if (event.op === `init` || event.op === `replace`) {
        content = event.content
      } else {
        // event.op === `patch`
        content = applyPatch(content, event.patch)
      }
    }

    // Cache the result
    this.contentCache.set(streamId, content)

    return content
  }
}

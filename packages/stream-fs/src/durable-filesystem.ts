/**
 * DurableFilesystem
 *
 * A shared filesystem abstraction for AI agents built on durable streams.
 * The stream is the source of truth—every mutation appends an event,
 * and reading reconstructs state by replaying history.
 */

import { diff_match_patch } from "diff-match-patch"

import {
  type ContentType,
  type CreateFileOptions,
  type Entry,
  type FileMetadata,
  type DirectoryMetadata,
  type Stat,
  type StreamFactory,
  type TextFileContent,
  type TextFilePatch,
  NotFoundError,
  AlreadyExistsError,
  DirectoryNotEmptyError,
  PatchApplicationError,
  TypeMismatchError,
  StreamFSError,
} from "./types"

/**
 * Options for creating a DurableFilesystem
 */
export interface DurableFilesystemOptions {
  /** Factory for creating all streams (metadata and content) */
  streamFactory: StreamFactory
  /** ID for the metadata stream (default: "__metadata__") */
  metadataStreamId?: string
}

/**
 * Change event stored in the metadata stream
 */
interface MetadataChangeEvent {
  type: "file" | "directory"
  key: string
  value?: FileMetadata | DirectoryMetadata
  headers: {
    operation: "insert" | "update" | "delete"
  }
}

/**
 * Content event stored in content streams
 */
interface ContentChangeEvent {
  type: "content"
  key: string
  value: TextFileContent | TextFilePatch
  headers: {
    operation: "insert" | "patch"
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a unique content stream ID
 */
function generateContentStreamId(): string {
  return `content_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

/**
 * Get parent directory path
 */
function getParentPath(path: string): string {
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash <= 0) return "/"
  return normalized.slice(0, lastSlash)
}

/**
 * Normalize a path (ensure leading slash, no trailing slash except root)
 */
function normalizePath(path: string): string {
  let normalized = path.startsWith("/") ? path : `/${path}`
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/**
 * Detect if content is binary based on first bytes
 */
function detectContentType(content: string | Uint8Array): ContentType {
  if (typeof content === "string") {
    return "text"
  }

  // Check for null bytes (binary indicator)
  for (let i = 0; i < Math.min(content.length, 8192); i++) {
    if (content[i] === 0) {
      return "binary"
    }
  }

  // Try to decode as UTF-8 - if it fails, it's binary
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content)
    return "text"
  } catch {
    return "binary"
  }
}

/**
 * Compute SHA-256 checksum of content
 */
async function computeChecksum(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

// =============================================================================
// DurableFilesystem Class
// =============================================================================

export class DurableFilesystem {
  private streamFactory: StreamFactory
  private metadataStreamId: string
  private initialized = false

  // Materialized metadata state
  private files = new Map<string, FileMetadata>()
  private directories = new Map<string, DirectoryMetadata>()

  // Content cache: contentStreamId -> current content
  private contentCache = new Map<string, string>()

  // diff-match-patch instance
  private dmp = new diff_match_patch()

  constructor(options: DurableFilesystemOptions) {
    this.streamFactory = options.streamFactory
    this.metadataStreamId = options.metadataStreamId ?? "__metadata__"
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the filesystem by loading metadata from the stream
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Ensure metadata stream exists
    try {
      const metadataStream = this.streamFactory.getStream(this.metadataStreamId)
      await metadataStream.head()
    } catch {
      await this.streamFactory.createStream(this.metadataStreamId, {
        contentType: "application/json",
      })
    }

    // Load existing metadata
    await this.loadMetadata()
    this.initialized = true
  }

  /**
   * Load metadata from the stream
   */
  private async loadMetadata(): Promise<void> {
    const metadataStream = this.streamFactory.getStream(this.metadataStreamId)

    try {
      const response = await metadataStream.stream<MetadataChangeEvent>({
        live: false,
      })
      const events = await response.json()

      // Clear current state
      this.files.clear()
      this.directories.clear()

      // Replay events to rebuild state
      for (const event of events) {
        this.applyMetadataEvent(event)
      }
    } catch {
      // Stream might be empty or not exist yet - that's fine
    }
  }

  /**
   * Apply a metadata change event to local state
   */
  private applyMetadataEvent(event: MetadataChangeEvent): void {
    if (event.type === "file") {
      if (event.headers.operation === "delete") {
        this.files.delete(event.key)
      } else if (event.value) {
        this.files.set(event.key, event.value as FileMetadata)
      }
    } else if (event.type === "directory") {
      if (event.headers.operation === "delete") {
        this.directories.delete(event.key)
      } else if (event.value) {
        this.directories.set(event.key, event.value as DirectoryMetadata)
      }
    }
  }

  /**
   * Ensure the filesystem is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }
  }

  /**
   * Append a metadata event to the stream and update local state
   */
  private async appendMetadataEvent(event: MetadataChangeEvent): Promise<void> {
    const metadataStream = this.streamFactory.getStream(this.metadataStreamId)
    await metadataStream.append(JSON.stringify(event))
    this.applyMetadataEvent(event)
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Create a new file
   */
  async createFile(
    path: string,
    content: string | Uint8Array,
    options?: CreateFileOptions
  ): Promise<void> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    // Check if file already exists
    if (this.files.has(normalizedPath)) {
      throw new AlreadyExistsError(normalizedPath)
    }

    // Check if a directory exists at this path
    if (this.directories.has(normalizedPath)) {
      throw new AlreadyExistsError(
        normalizedPath,
        `A directory already exists at ${normalizedPath}`
      )
    }

    // Ensure parent directory exists
    const parentPath = getParentPath(normalizedPath)
    if (parentPath !== "/" && !this.directories.has(parentPath)) {
      throw new NotFoundError(
        parentPath,
        `Parent directory does not exist: ${parentPath}`
      )
    }

    // Detect content type
    const contentType = options?.contentType ?? detectContentType(content)

    // Convert content to string if needed
    const contentString =
      typeof content === "string" ? content : new TextDecoder().decode(content)

    // Generate content stream ID and create content stream
    const contentStreamId = generateContentStreamId()
    const contentStream = await this.streamFactory.createStream(contentStreamId, {
      contentType: "application/json",
    })

    // Initialize content stream with initial content
    const contentInitEvent: ContentChangeEvent = {
      type: "content",
      key: contentStreamId,
      value: { id: contentStreamId, content: contentString },
      headers: { operation: "insert" },
    }
    await contentStream.append(JSON.stringify(contentInitEvent))

    // Cache the content
    this.contentCache.set(contentStreamId, contentString)

    // Create file metadata
    const now = Date.now()
    const fileMetadata: FileMetadata = {
      path: normalizedPath,
      contentStreamId,
      contentType,
      mimeType: options?.mimeType,
      size: contentString.length,
      createdAt: now,
      updatedAt: now,
    }

    await this.appendMetadataEvent({
      type: "file",
      key: normalizedPath,
      value: fileMetadata,
      headers: { operation: "insert" },
    })
  }

  /**
   * Write content to an existing file (computes diff automatically)
   */
  async writeFile(path: string, newContent: string | Uint8Array): Promise<void> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    // Get file metadata
    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      throw new NotFoundError(normalizedPath)
    }

    // Get current content
    const currentContent = await this.getFileContent(fileMeta.contentStreamId)

    // Convert new content to string
    const newContentString =
      typeof newContent === "string"
        ? newContent
        : new TextDecoder().decode(newContent)

    // If content is the same, no-op
    if (currentContent === newContentString) {
      return
    }

    // Compute diff
    const patches = this.dmp.patch_make(currentContent, newContentString)
    const patchText = this.dmp.patch_toText(patches)

    // Apply patch to verify it works
    const [, results] = this.dmp.patch_apply(patches, currentContent)
    if (!results.every((r) => r)) {
      throw new PatchApplicationError(
        normalizedPath,
        "Computed patch does not apply cleanly"
      )
    }

    // Get content stream
    const contentStream = this.streamFactory.getStream(fileMeta.contentStreamId)

    // Append patch event to content stream
    const checksum = await computeChecksum(newContentString)
    const patchEvent: ContentChangeEvent = {
      type: "content",
      key: fileMeta.contentStreamId,
      value: {
        id: fileMeta.contentStreamId,
        patch: patchText,
        checksum,
      },
      headers: { operation: "patch" },
    }
    await contentStream.append(JSON.stringify(patchEvent))

    // Update cache
    this.contentCache.set(fileMeta.contentStreamId, newContentString)

    // Update file metadata
    const now = Date.now()
    const updatedMeta: FileMetadata = {
      ...fileMeta,
      size: newContentString.length,
      updatedAt: now,
    }

    await this.appendMetadataEvent({
      type: "file",
      key: normalizedPath,
      value: updatedMeta,
      headers: { operation: "update" },
    })
  }

  /**
   * Read file content as Uint8Array
   */
  async readFile(path: string): Promise<Uint8Array> {
    const content = await this.readTextFile(path)
    return new TextEncoder().encode(content)
  }

  /**
   * Read file content as string
   */
  async readTextFile(path: string): Promise<string> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    // Check if it's a directory first
    if (this.directories.has(normalizedPath)) {
      throw new TypeMismatchError(normalizedPath, "file", "directory")
    }

    // Get file metadata
    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      throw new NotFoundError(normalizedPath)
    }

    return this.getFileContent(fileMeta.contentStreamId)
  }

  /**
   * Get file content from cache or stream
   */
  private async getFileContent(contentStreamId: string): Promise<string> {
    // Check cache
    const cached = this.contentCache.get(contentStreamId)
    if (cached !== undefined) {
      return cached
    }

    // Load from stream
    const contentStream = this.streamFactory.getStream(contentStreamId)

    // Read all events and materialize content
    const response = await contentStream.stream<ContentChangeEvent>({
      live: false,
    })
    const events = await response.json()

    let content = ""
    for (const event of events) {
      if (event.headers.operation === "insert") {
        content = (event.value as TextFileContent).content
      } else if (event.headers.operation === "patch") {
        const patchValue = event.value as TextFilePatch
        const patches = this.dmp.patch_fromText(patchValue.patch)
        const [applied, results] = this.dmp.patch_apply(patches, content)
        if (!results.every((r) => r)) {
          throw new PatchApplicationError(
            contentStreamId,
            "Patch does not apply cleanly during replay"
          )
        }
        content = applied
      }
    }

    // Cache the result
    this.contentCache.set(contentStreamId, content)
    return content
  }

  /**
   * Delete a file
   */
  async deleteFile(path: string): Promise<void> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    // Get file metadata
    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      throw new NotFoundError(normalizedPath)
    }

    // Delete content stream
    await this.streamFactory.deleteStream(fileMeta.contentStreamId)

    // Remove from cache
    this.contentCache.delete(fileMeta.contentStreamId)

    // Delete file metadata
    await this.appendMetadataEvent({
      type: "file",
      key: normalizedPath,
      headers: { operation: "delete" },
    })
  }

  /**
   * Apply a text patch directly (advanced usage)
   */
  async applyTextPatch(path: string, patchText: string): Promise<void> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    // Get file metadata
    const fileMeta = this.files.get(normalizedPath)
    if (!fileMeta) {
      throw new NotFoundError(normalizedPath)
    }

    if (fileMeta.contentType !== "text") {
      throw new TypeMismatchError(
        normalizedPath,
        "file",
        "file",
        `Cannot apply text patch to binary file: ${normalizedPath}`
      )
    }

    // Get current content
    const currentContent = await this.getFileContent(fileMeta.contentStreamId)

    // Parse and apply patch
    const patches = this.dmp.patch_fromText(patchText)
    const [applied, results] = this.dmp.patch_apply(patches, currentContent)

    if (!results.every((r) => r)) {
      throw new PatchApplicationError(normalizedPath, "Patch does not apply cleanly")
    }

    // Get content stream
    const contentStream = this.streamFactory.getStream(fileMeta.contentStreamId)

    // Append patch event
    const checksum = await computeChecksum(applied)
    const patchEvent: ContentChangeEvent = {
      type: "content",
      key: fileMeta.contentStreamId,
      value: {
        id: fileMeta.contentStreamId,
        patch: patchText,
        checksum,
      },
      headers: { operation: "patch" },
    }
    await contentStream.append(JSON.stringify(patchEvent))

    // Update cache
    this.contentCache.set(fileMeta.contentStreamId, applied)

    // Update file metadata
    const now = Date.now()
    const updatedMeta: FileMetadata = {
      ...fileMeta,
      size: applied.length,
      updatedAt: now,
    }

    await this.appendMetadataEvent({
      type: "file",
      key: normalizedPath,
      value: updatedMeta,
      headers: { operation: "update" },
    })
  }

  // ===========================================================================
  // Directory Operations
  // ===========================================================================

  /**
   * Create a directory
   */
  async mkdir(path: string): Promise<void> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (normalizedPath === "/") {
      // Root always exists
      return
    }

    // Check if directory already exists
    if (this.directories.has(normalizedPath)) {
      throw new AlreadyExistsError(normalizedPath)
    }

    // Check if a file exists at this path
    if (this.files.has(normalizedPath)) {
      throw new AlreadyExistsError(
        normalizedPath,
        `A file already exists at ${normalizedPath}`
      )
    }

    // Ensure parent directory exists
    const parentPath = getParentPath(normalizedPath)
    if (parentPath !== "/" && !this.directories.has(parentPath)) {
      throw new NotFoundError(
        parentPath,
        `Parent directory does not exist: ${parentPath}`
      )
    }

    // Create directory metadata
    const dirMetadata: DirectoryMetadata = {
      path: normalizedPath,
      createdAt: Date.now(),
    }

    await this.appendMetadataEvent({
      type: "directory",
      key: normalizedPath,
      value: dirMetadata,
      headers: { operation: "insert" },
    })
  }

  /**
   * Remove a directory (must be empty)
   */
  async rmdir(path: string): Promise<void> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (normalizedPath === "/") {
      throw new StreamFSError("Cannot remove root directory")
    }

    // Check if directory exists
    if (!this.directories.has(normalizedPath)) {
      throw new NotFoundError(normalizedPath)
    }

    // Check if directory is empty
    const entries = await this.list(normalizedPath)
    if (entries.length > 0) {
      throw new DirectoryNotEmptyError(normalizedPath)
    }

    // Delete directory metadata
    await this.appendMetadataEvent({
      type: "directory",
      key: normalizedPath,
      headers: { operation: "delete" },
    })
  }

  /**
   * List directory contents
   */
  async list(path: string): Promise<Entry[]> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    const entries: Entry[] = []
    const prefix = normalizedPath === "/" ? "/" : `${normalizedPath}/`

    // Filter files in this directory
    for (const [filePath, file] of this.files) {
      if (filePath.startsWith(prefix)) {
        const relativePath = filePath.slice(prefix.length)
        // Only include direct children (no nested paths)
        if (!relativePath.includes("/")) {
          entries.push({
            name: relativePath,
            path: filePath,
            type: "file",
            size: file.size,
            contentType: file.contentType,
            mimeType: file.mimeType,
          })
        }
      }
    }

    // Filter directories in this directory
    for (const [dirPath, dir] of this.directories) {
      if (dirPath.startsWith(prefix)) {
        const relativePath = dirPath.slice(prefix.length)
        // Only include direct children (no nested paths)
        if (!relativePath.includes("/")) {
          entries.push({
            name: relativePath,
            path: dirPath,
            type: "directory",
          })
        }
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ===========================================================================
  // Metadata Operations
  // ===========================================================================

  /**
   * Check if a path exists
   */
  async exists(path: string): Promise<boolean> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (normalizedPath === "/") return true

    return this.files.has(normalizedPath) || this.directories.has(normalizedPath)
  }

  /**
   * Check if a path is a directory
   */
  async isDirectory(path: string): Promise<boolean> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (normalizedPath === "/") return true

    return this.directories.has(normalizedPath)
  }

  /**
   * Get stat info for a path
   */
  async stat(path: string): Promise<Stat> {
    await this.ensureInitialized()
    const normalizedPath = normalizePath(path)

    if (normalizedPath === "/") {
      return {
        path: "/",
        type: "directory",
        createdAt: 0, // Root has no creation time
      }
    }

    const file = this.files.get(normalizedPath)
    if (file) {
      return {
        path: file.path,
        type: "file",
        size: file.size,
        contentType: file.contentType,
        mimeType: file.mimeType,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      }
    }

    const dir = this.directories.get(normalizedPath)
    if (dir) {
      return {
        path: dir.path,
        type: "directory",
        createdAt: dir.createdAt,
      }
    }

    throw new NotFoundError(normalizedPath)
  }

  // ===========================================================================
  // Synchronization
  // ===========================================================================

  /**
   * Refresh metadata from the stream (see other agents' changes)
   */
  async refresh(): Promise<void> {
    await this.ensureInitialized()

    // Clear content cache to force reload
    this.contentCache.clear()

    // Reload metadata
    await this.loadMetadata()
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  /**
   * Evict a file from the content cache
   */
  evictFromCache(path: string): void {
    const normalizedPath = normalizePath(path)
    const file = this.files.get(normalizedPath)
    if (file) {
      this.contentCache.delete(file.contentStreamId)
    }
  }

  /**
   * Clear all content caches
   */
  clearContentCache(): void {
    this.contentCache.clear()
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Close the filesystem and cleanup resources
   */
  close(): void {
    this.contentCache.clear()
    this.files.clear()
    this.directories.clear()
    this.initialized = false
  }
}

export { StreamFSError }

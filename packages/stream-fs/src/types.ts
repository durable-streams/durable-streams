/**
 * Stream-FS Type Definitions
 */

export type ContentType = `text` | `binary`

export type EntryType = `file` | `directory`

// Metadata Types

export interface BaseMetadata {
  type: EntryType
  createdAt: string
  modifiedAt: string
}

export interface FileMetadata extends BaseMetadata {
  type: `file`
  contentStreamId: string
  contentType: ContentType
  mimeType: string
  size: number
}

export interface DirectoryMetadata extends BaseMetadata {
  type: `directory`
}

export type Metadata = FileMetadata | DirectoryMetadata

export function isFileMetadata(meta: Metadata): meta is FileMetadata {
  return meta.type === `file`
}

export function isDirectoryMetadata(meta: Metadata): meta is DirectoryMetadata {
  return meta.type === `directory`
}

// Content Event Types

interface BaseContentEvent {
  checksum: string
}

export interface InitContentEvent extends BaseContentEvent {
  op: `init`
  content: string
}

export interface PatchContentEvent extends BaseContentEvent {
  op: `patch`
  patch: string
}

export interface ReplaceContentEvent extends BaseContentEvent {
  op: `replace`
  content: string
  encoding?: `base64`
}

export type ContentEvent =
  | InitContentEvent
  | PatchContentEvent
  | ReplaceContentEvent

export function isInitEvent(event: ContentEvent): event is InitContentEvent {
  return event.op === `init`
}

export function isPatchEvent(event: ContentEvent): event is PatchContentEvent {
  return event.op === `patch`
}

export function isReplaceEvent(
  event: ContentEvent
): event is ReplaceContentEvent {
  return event.op === `replace`
}

// Watch Types

export type WatchEventType =
  | `add`
  | `change`
  | `unlink`
  | `addDir`
  | `unlinkDir`

export interface WatchEvent {
  eventType: WatchEventType
  path: string
  metadata?: FileMetadata | DirectoryMetadata
  offset: string
}

export interface WatchOptions {
  path?: string
  recursive?: boolean
  signal?: AbortSignal
}

export interface Watcher {
  on: ((
    event: WatchEventType,
    cb: (path: string, metadata?: Metadata) => void
  ) => Watcher) &
    ((
      event: `all`,
      cb: (eventType: WatchEventType, path: string, metadata?: Metadata) => void
    ) => Watcher) &
    ((event: `ready`, cb: () => void) => Watcher) &
    ((event: `error`, cb: (error: Error) => void) => Watcher)
  close: () => void
  readonly closed: Promise<void>
}

// Stat and Entry Types

export interface Stat {
  type: EntryType
  size: number
  createdAt: string
  modifiedAt: string
  mimeType?: string
  contentType?: ContentType
}

export interface Entry {
  name: string
  type: EntryType
  size: number
  modifiedAt: string
}

// Options

export interface CreateFileOptions {
  mimeType?: string
  contentType?: ContentType
}

export interface StreamFilesystemOptions {
  baseUrl: string
  streamPrefix: string
  headers?: Record<string, string>
}

// Error Types

export class StreamFsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = `StreamFsError`
  }
}

export class NotFoundError extends StreamFsError {
  readonly path: string
  readonly code = `ENOENT`

  constructor(path: string) {
    super(`ENOENT: no such file or directory, '${path}'`)
    this.name = `NotFoundError`
    this.path = path
  }
}

export class ExistsError extends StreamFsError {
  readonly path: string
  readonly code = `EEXIST`

  constructor(path: string) {
    super(`EEXIST: file already exists, '${path}'`)
    this.name = `ExistsError`
    this.path = path
  }
}

export class IsDirectoryError extends StreamFsError {
  readonly path: string
  readonly code = `EISDIR`

  constructor(path: string) {
    super(`EISDIR: illegal operation on a directory, '${path}'`)
    this.name = `IsDirectoryError`
    this.path = path
  }
}

export class NotDirectoryError extends StreamFsError {
  readonly path: string
  readonly code = `ENOTDIR`

  constructor(path: string) {
    super(`ENOTDIR: not a directory, '${path}'`)
    this.name = `NotDirectoryError`
    this.path = path
  }
}

export class DirectoryNotEmptyError extends StreamFsError {
  readonly path: string
  readonly code = `ENOTEMPTY`

  constructor(path: string) {
    super(`ENOTEMPTY: directory not empty, '${path}'`)
    this.name = `DirectoryNotEmptyError`
    this.path = path
  }
}

export class PatchApplicationError extends StreamFsError {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string, message?: string) {
    super(message ?? `Patch application failed for '${path}': ${reason}`)
    this.name = `PatchApplicationError`
    this.path = path
    this.reason = reason
  }
}

export class PreconditionFailedError extends StreamFsError {
  readonly path: string
  readonly code = `ECONFLICT`

  constructor(path: string, message?: string) {
    super(
      message ?? `Precondition failed: concurrent modification of '${path}'`
    )
    this.name = `PreconditionFailedError`
    this.path = path
  }
}

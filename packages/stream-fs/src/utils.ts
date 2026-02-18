/**
 * Stream-FS Utility Functions
 */

import { diff_match_patch } from "diff-match-patch"

const dmp = new diff_match_patch()

// Path Utilities

/**
 * Normalize a path to canonical form:
 * - Always starts with /
 * - No trailing slash (except root)
 * - No double slashes
 * - No . or .. components
 */
export function normalizePath(path: string): string {
  const parts = path.split(`/`).filter((p) => p !== `` && p !== `.`)

  const resolved: Array<string> = []
  for (const part of parts) {
    if (part === `..`) {
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  return `/${resolved.join(`/`)}`
}

export function dirname(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === `/`) {
    return `/`
  }
  const lastSlash = normalized.lastIndexOf(`/`)
  if (lastSlash === 0) {
    return `/`
  }
  return normalized.slice(0, lastSlash)
}

export function basename(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === `/`) {
    return ``
  }
  const lastSlash = normalized.lastIndexOf(`/`)
  return normalized.slice(lastSlash + 1)
}

export function joinPath(...segments: Array<string>): string {
  return normalizePath(segments.join(`/`))
}

// Content Stream ID Generation

export function generateContentStreamId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 11)
  return `content_${timestamp}_${random}`
}

// Checksum Utilities

export async function calculateChecksum(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest(`SHA-256`, data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, `0`)).join(``)
}

// Diff-Match-Patch Utilities

export function createPatch(oldContent: string, newContent: string): string {
  const patches = dmp.patch_make(oldContent, newContent)
  return dmp.patch_toText(patches)
}

/**
 * Apply a patch to content.
 * Throws if patch cannot be applied cleanly.
 */
export function applyPatch(content: string, patchText: string): string {
  const patches = dmp.patch_fromText(patchText)
  const [result, applied] = dmp.patch_apply(patches, content)

  if (applied.some((success) => !success)) {
    throw new Error(`Failed to apply patch cleanly`)
  }

  return result
}

export function canApplyPatch(content: string, patchText: string): boolean {
  try {
    const patches = dmp.patch_fromText(patchText)
    const [, applied] = dmp.patch_apply(patches, content)
    return applied.every((success) => success)
  } catch {
    return false
  }
}

// MIME Type Detection

const MIME_TYPES: Record<string, string> = {
  // Text
  txt: `text/plain`,
  md: `text/markdown`,
  markdown: `text/markdown`,
  html: `text/html`,
  htm: `text/html`,
  css: `text/css`,
  csv: `text/csv`,

  // Code
  js: `text/javascript`,
  mjs: `text/javascript`,
  ts: `text/typescript`,
  mts: `text/typescript`,
  jsx: `text/javascript`,
  tsx: `text/typescript`,
  json: `application/json`,
  xml: `application/xml`,
  yaml: `text/yaml`,
  yml: `text/yaml`,
  toml: `text/toml`,

  // Programming languages
  py: `text/x-python`,
  rb: `text/x-ruby`,
  go: `text/x-go`,
  rs: `text/x-rust`,
  java: `text/x-java`,
  c: `text/x-c`,
  cpp: `text/x-c++`,
  h: `text/x-c`,
  hpp: `text/x-c++`,
  cs: `text/x-csharp`,
  swift: `text/x-swift`,
  kt: `text/x-kotlin`,
  scala: `text/x-scala`,
  php: `text/x-php`,
  sh: `text/x-shellscript`,
  bash: `text/x-shellscript`,
  zsh: `text/x-shellscript`,
  sql: `text/x-sql`,

  // Images
  png: `image/png`,
  jpg: `image/jpeg`,
  jpeg: `image/jpeg`,
  gif: `image/gif`,
  svg: `image/svg+xml`,
  webp: `image/webp`,
  ico: `image/x-icon`,

  // Documents
  pdf: `application/pdf`,
  doc: `application/msword`,
  docx: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
  xls: `application/vnd.ms-excel`,
  xlsx: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,

  // Archives
  zip: `application/zip`,
  tar: `application/x-tar`,
  gz: `application/gzip`,

  // Other
  wasm: `application/wasm`,
}

export function detectMimeType(path: string): string {
  const ext = path.split(`.`).pop()?.toLowerCase()
  if (ext && ext in MIME_TYPES) {
    return MIME_TYPES[ext]!
  }
  return `application/octet-stream`
}

export function isTextContent(content: Uint8Array): boolean {
  for (let i = 0; i < Math.min(content.length, 8000); i++) {
    if (content[i] === 0) {
      return false
    }
  }

  let printable = 0
  const sampleSize = Math.min(content.length, 1000)
  for (let i = 0; i < sampleSize; i++) {
    const byte = content[i]!
    if (
      (byte >= 32 && byte <= 126) ||
      byte === 9 ||
      byte === 10 ||
      byte === 13
    ) {
      printable++
    }
  }

  return printable / sampleSize > 0.9
}

export function detectContentType(mimeType: string): `text` | `binary` {
  if (
    mimeType.startsWith(`text/`) ||
    mimeType === `application/json` ||
    mimeType === `application/xml` ||
    mimeType === `application/javascript` ||
    mimeType.endsWith(`+xml`) ||
    mimeType.endsWith(`+json`)
  ) {
    return `text`
  }
  return `binary`
}

// Binary Encoding

export function encodeBase64(data: Uint8Array): string {
  if (typeof Buffer !== `undefined`) {
    return Buffer.from(data).toString(`base64`)
  }

  let binary = ``
  for (const byte of data) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function decodeBase64(base64: string): Uint8Array {
  if (typeof Buffer !== `undefined`) {
    return new Uint8Array(Buffer.from(base64, `base64`))
  }

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Timestamp Utilities

export function now(): string {
  return new Date().toISOString()
}

/**
 * Stream-FS Utility Functions
 */

import { diff_match_patch } from "diff-match-patch"

const dmp = new diff_match_patch()

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Normalize a path to canonical form:
 * - Always starts with /
 * - No trailing slash (except root)
 * - No double slashes
 * - No . or .. components
 */
export function normalizePath(path: string): string {
  // Ensure path starts with /
  let normalized = path.startsWith(`/`) ? path : `/${path}`

  // Split into components and filter out empty and . components
  const parts = normalized.split(`/`).filter((p) => p !== `` && p !== `.`)

  // Handle .. components
  const resolved: Array<string> = []
  for (const part of parts) {
    if (part === `..`) {
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  // Rejoin
  normalized = `/${resolved.join(`/`)}`

  // Remove trailing slash (except for root)
  while (normalized.length > 1 && normalized.endsWith(`/`)) {
    normalized = normalized.slice(0, -1)
  }

  return normalized
}

/**
 * Get the parent directory of a path
 */
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

/**
 * Get the base name of a path
 */
export function basename(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === `/`) {
    return ``
  }
  const lastSlash = normalized.lastIndexOf(`/`)
  return normalized.slice(lastSlash + 1)
}

/**
 * Join path segments
 */
export function joinPath(...segments: Array<string>): string {
  return normalizePath(segments.join(`/`))
}

// ============================================================================
// Content Stream ID Generation
// ============================================================================

/**
 * Generate a unique content stream ID
 */
export function generateContentStreamId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 11)
  return `content_${timestamp}_${random}`
}

// ============================================================================
// Checksum Utilities
// ============================================================================

/**
 * Calculate SHA-256 checksum of content
 * Works in both Node.js and browser environments
 */
export async function calculateChecksum(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)

  // Use Web Crypto API (available in both Node.js and browsers)
  const hashBuffer = await crypto.subtle.digest(`SHA-256`, data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, `0`)).join(``)
}

// ============================================================================
// Diff-Match-Patch Utilities
// ============================================================================

/**
 * Create a patch from old content to new content
 */
export function createPatch(oldContent: string, newContent: string): string {
  const patches = dmp.patch_make(oldContent, newContent)
  return dmp.patch_toText(patches)
}

/**
 * Apply a patch to content
 * @returns The patched content
 * @throws Error if patch cannot be applied cleanly
 */
export function applyPatch(content: string, patchText: string): string {
  const patches = dmp.patch_fromText(patchText)
  const [result, applied] = dmp.patch_apply(patches, content)

  // Check if all patches were applied successfully
  if (applied.some((success) => !success)) {
    throw new Error(`Failed to apply patch cleanly`)
  }

  return result
}

/**
 * Check if a patch can be applied cleanly
 */
export function canApplyPatch(content: string, patchText: string): boolean {
  try {
    const patches = dmp.patch_fromText(patchText)
    const [, applied] = dmp.patch_apply(patches, content)
    return applied.every((success) => success)
  } catch {
    return false
  }
}

// ============================================================================
// MIME Type Detection
// ============================================================================

/**
 * Common MIME types by extension
 */
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

/**
 * Detect MIME type from file path
 */
export function detectMimeType(path: string): string {
  const ext = path.split(`.`).pop()?.toLowerCase()
  if (ext && ext in MIME_TYPES) {
    return MIME_TYPES[ext]!
  }
  return `application/octet-stream`
}

/**
 * Check if content is likely text (vs binary)
 */
export function isTextContent(content: Uint8Array): boolean {
  // Check for null bytes (common in binary)
  for (let i = 0; i < Math.min(content.length, 8000); i++) {
    if (content[i] === 0) {
      return false
    }
  }

  // Check if most bytes are printable ASCII or common whitespace
  let printable = 0
  const sampleSize = Math.min(content.length, 1000)
  for (let i = 0; i < sampleSize; i++) {
    const byte = content[i]!
    // Printable ASCII (32-126) or common whitespace (9, 10, 13)
    if (
      (byte >= 32 && byte <= 126) ||
      byte === 9 ||
      byte === 10 ||
      byte === 13
    ) {
      printable++
    }
  }

  // If more than 90% is printable, treat as text
  return printable / sampleSize > 0.9
}

/**
 * Detect content type from MIME type
 */
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

// ============================================================================
// Binary Encoding
// ============================================================================

/**
 * Encode binary data to base64
 */
export function encodeBase64(data: Uint8Array): string {
  // Use Buffer in Node.js, btoa in browser
  if (typeof Buffer !== `undefined`) {
    return Buffer.from(data).toString(`base64`)
  }

  // Browser fallback
  let binary = ``
  for (const byte of data) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * Decode base64 to binary data
 */
export function decodeBase64(base64: string): Uint8Array {
  // Use Buffer in Node.js, atob in browser
  if (typeof Buffer !== `undefined`) {
    return new Uint8Array(Buffer.from(base64, `base64`))
  }

  // Browser fallback
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ============================================================================
// Timestamp Utilities
// ============================================================================

/**
 * Get current timestamp in ISO 8601 format
 */
export function now(): string {
  return new Date().toISOString()
}

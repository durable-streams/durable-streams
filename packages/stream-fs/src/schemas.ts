/**
 * Standard Schema definitions for stream-fs types
 *
 * These schemas are used with @durable-streams/state for validation
 * and type inference.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type {
  FileMetadata,
  DirectoryMetadata,
  TextFileContent,
  TextFilePatch,
  BinaryFileContent,
  BinaryFileDelta,
} from "./types"

// =============================================================================
// Schema Helpers
// =============================================================================

/**
 * Create a simple schema that validates an object has certain properties
 */
function createObjectSchema<T extends object>(
  validator: (value: unknown) => value is T
): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "stream-fs",
      validate: (value: unknown) => {
        if (validator(value)) {
          return { value }
        }
        return {
          issues: [{ message: "Invalid value" }],
        }
      },
    },
  }
}

// =============================================================================
// Type Guards
// =============================================================================

function isFileMetadata(value: unknown): value is FileMetadata {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.path === "string" &&
    typeof v.contentStreamId === "string" &&
    (v.contentType === "text" || v.contentType === "binary") &&
    typeof v.size === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  )
}

function isDirectoryMetadata(value: unknown): value is DirectoryMetadata {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.path === "string" && typeof v.createdAt === "number"
}

function isTextFileContent(value: unknown): value is TextFileContent {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.content === "string"
}

function isTextFilePatch(value: unknown): value is TextFilePatch {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.patch === "string"
}

function isBinaryFileContent(value: unknown): value is BinaryFileContent {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.content === "string"
}

function isBinaryFileDelta(value: unknown): value is BinaryFileDelta {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.delta === "string"
}

// =============================================================================
// Schemas
// =============================================================================

/**
 * Schema for file metadata
 */
export const fileMetadataSchema: StandardSchemaV1<FileMetadata> =
  createObjectSchema(isFileMetadata)

/**
 * Schema for directory metadata
 */
export const directoryMetadataSchema: StandardSchemaV1<DirectoryMetadata> =
  createObjectSchema(isDirectoryMetadata)

/**
 * Schema for text file content
 */
export const textContentSchema: StandardSchemaV1<TextFileContent> =
  createObjectSchema(isTextFileContent)

/**
 * Schema for text file patch
 */
export const textPatchSchema: StandardSchemaV1<TextFilePatch> =
  createObjectSchema(isTextFilePatch)

/**
 * Schema for binary file content
 */
export const binaryContentSchema: StandardSchemaV1<BinaryFileContent> =
  createObjectSchema(isBinaryFileContent)

/**
 * Schema for binary file delta
 */
export const binaryDeltaSchema: StandardSchemaV1<BinaryFileDelta> =
  createObjectSchema(isBinaryFileDelta)

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ChangeEvent } from "./types"

// ============================================================================
// Schema Definitions
//
// This module is intentionally free of any @tanstack/db dependency: it covers
// the producer side of the state protocol (defining schemas and constructing
// validated change events). The reactive, TanStack DB-backed surface lives in
// ./stream-db and is published under the `@durable-streams/state/db` subpath.
// ============================================================================

/**
 * Definition for a single collection in the stream state
 */
export interface CollectionDefinition<T = unknown> {
  /** Standard Schema for validating values */
  schema: StandardSchemaV1<T>
  /** The type field value in change events that map to this collection */
  type: string
  /** The property name in T that serves as the primary key */
  primaryKey: string
}

/**
 * Helper methods for creating change events for a collection
 */
export interface CollectionEventHelpers<T> {
  /**
   * Create an insert change event
   */
  insert: (params: {
    key?: string
    value: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create an update change event
   */
  update: (params: {
    key?: string
    value: T
    oldValue?: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create a delete change event
   */
  delete: (params: {
    key?: string
    oldValue?: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create an upsert change event (insert or update)
   */
  upsert: (params: {
    key?: string
    value: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
}

/**
 * Collection definition enhanced with event creation helpers
 */
export type CollectionWithHelpers<T = unknown> = CollectionDefinition<T> &
  CollectionEventHelpers<T>

/**
 * Stream state definition containing all collections
 */
export type StreamStateDefinition = Record<string, CollectionDefinition>

/**
 * Stream state schema with helper methods for creating change events
 */
export type StateSchema<T extends Record<string, CollectionDefinition>> = {
  [K in keyof T]: CollectionWithHelpers<
    T[K] extends CollectionDefinition<infer U> ? U : unknown
  >
}

/**
 * Reserved collection names that would collide with StreamDB properties
 * (collections are now namespaced, but we still prevent internal name collisions)
 */
const RESERVED_COLLECTION_NAMES = new Set([
  `collections`,
  `preload`,
  `close`,
  `utils`,
  `actions`,
])

/**
 * Create helper functions for a collection
 */
function createCollectionHelpers<T>(
  eventType: string,
  primaryKey: string,
  schema: StandardSchemaV1<T>
): CollectionEventHelpers<T> {
  return {
    insert: ({ key, value, headers }): ChangeEvent<T> => {
      // Validate value
      const result = schema[`~standard`].validate(value)
      if (`issues` in result) {
        throw new Error(
          `Validation failed for ${eventType} insert: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
        )
      }

      // Derive key from value if not explicitly provided
      const derived = (value as any)[primaryKey]
      const finalKey =
        key ?? (derived != null && derived !== `` ? String(derived) : undefined)
      if (finalKey == null || finalKey === ``) {
        throw new Error(
          `Cannot create ${eventType} insert event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        value,
        headers: { ...headers, operation: `insert` },
      }
    },
    update: ({ key, value, oldValue, headers }): ChangeEvent<T> => {
      // Validate value
      const result = schema[`~standard`].validate(value)
      if (`issues` in result) {
        throw new Error(
          `Validation failed for ${eventType} update: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
        )
      }

      // Optionally validate oldValue if provided
      if (oldValue !== undefined) {
        const oldResult = schema[`~standard`].validate(oldValue)
        if (`issues` in oldResult) {
          throw new Error(
            `Validation failed for ${eventType} update (oldValue): ${oldResult.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
          )
        }
      }

      // Derive key from value if not explicitly provided
      const derived = (value as any)[primaryKey]
      const finalKey =
        key ?? (derived != null && derived !== `` ? String(derived) : undefined)
      if (finalKey == null || finalKey === ``) {
        throw new Error(
          `Cannot create ${eventType} update event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        value,
        old_value: oldValue,
        headers: { ...headers, operation: `update` },
      }
    },
    delete: ({ key, oldValue, headers }): ChangeEvent<T> => {
      // Optionally validate oldValue if provided
      if (oldValue !== undefined) {
        const result = schema[`~standard`].validate(oldValue)
        if (`issues` in result) {
          throw new Error(
            `Validation failed for ${eventType} delete (oldValue): ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
          )
        }
      }

      // Ensure we have either key or oldValue to derive the key from
      const finalKey =
        key ?? (oldValue ? String((oldValue as any)[primaryKey]) : undefined)
      if (!finalKey) {
        throw new Error(
          `Cannot create ${eventType} delete event: must provide either 'key' or 'oldValue' with a ${primaryKey} field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        old_value: oldValue,
        headers: { ...headers, operation: `delete` },
      }
    },
    upsert: ({ key, value, headers }): ChangeEvent<T> => {
      // Validate value
      const result = schema[`~standard`].validate(value)
      if (`issues` in result) {
        throw new Error(
          `Validation failed for ${eventType} upsert: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
        )
      }

      // Derive key from value if not explicitly provided
      const derived = (value as any)[primaryKey]
      const finalKey =
        key ?? (derived != null && derived !== `` ? String(derived) : undefined)
      if (finalKey == null || finalKey === ``) {
        throw new Error(
          `Cannot create ${eventType} upsert event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        value,
        headers: { ...headers, operation: `upsert` },
      }
    },
  }
}

/**
 * Create a state schema definition with typed collections and event helpers
 */
export function createStateSchema<
  T extends Record<string, CollectionDefinition>,
>(collections: T): StateSchema<T> {
  // Validate no reserved collection names
  for (const name of Object.keys(collections)) {
    if (RESERVED_COLLECTION_NAMES.has(name)) {
      throw new Error(
        `Reserved collection name "${name}" - this would collide with StreamDB properties (${Array.from(RESERVED_COLLECTION_NAMES).join(`, `)})`
      )
    }
  }

  // Validate no duplicate event types
  const typeToCollection = new Map<string, string>()
  for (const [collectionName, def] of Object.entries(collections)) {
    const existing = typeToCollection.get(def.type)
    if (existing) {
      throw new Error(
        `Duplicate event type "${def.type}" - used by both "${existing}" and "${collectionName}" collections`
      )
    }
    typeToCollection.set(def.type, collectionName)
  }

  // Enhance collections with helper methods
  const enhancedCollections: any = {}
  for (const [name, collectionDef] of Object.entries(collections)) {
    enhancedCollections[name] = {
      ...collectionDef,
      ...createCollectionHelpers(
        collectionDef.type,
        collectionDef.primaryKey,
        collectionDef.schema
      ),
    }
  }

  return enhancedCollections
}

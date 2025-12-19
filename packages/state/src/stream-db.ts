import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { DurableStream } from "@durable-streams/writer"

/**
 * Definition for a single collection in the stream state
 */
export interface CollectionDefinition<T = unknown> {
  /** Standard Schema for validating values */
  schema: StandardSchemaV1<T>
  /** The type field value in change events that map to this collection */
  type: string
}

/**
 * Stream state definition containing all collections
 */
export interface StreamStateDefinition {
  collections: Record<string, CollectionDefinition>
}

/**
 * Options for creating a stream DB
 */
export interface CreateStreamDBOptions {
  /** The durable stream to subscribe to */
  stream: DurableStream
  /** The stream state definition */
  state: StreamStateDefinition
}

/**
 * Define the structure of a stream state with typed collections
 */
export function defineStreamState<
  T extends Record<string, CollectionDefinition>,
>(definition: { collections: T }): { collections: T } {
  return definition
}

/**
 * Create a stream-backed database with TanStack DB collections
 */
export async function createStreamDB(
  _options: CreateStreamDBOptions
): Promise<unknown> {
  // TODO: Implement
  return Promise.reject(new Error(`Not implemented yet`))
}

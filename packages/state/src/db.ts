// `@durable-streams/state/db`: the full surface, including the reactive,
// TanStack DB-backed StreamDB layer. Importing this entry pulls in @tanstack/db,
// which is a peer dependency — consumers using this subpath must install it.
//
// It is a strict superset of the db-free main entry (`@durable-streams/state`),
// so code that uses both `createStateSchema` and `createStreamDB` can import
// everything from here.

export * from "./index"

// Reactive StreamDB layer
export { createStreamDB, getStreamDBCollectionId } from "./stream-db"
export type {
  CreateStreamDBOptions,
  StreamDB,
  StreamDBMethods,
  StreamDBUtils,
  StreamDBWithActions,
  ActionFactory,
  ActionMap,
  ActionDefinition,
} from "./stream-db"

// Re-export key types and utilities from @tanstack/db for convenience.
// This ensures consumers can use the same module resolution for type compatibility.
export type { Collection, SyncConfig } from "@tanstack/db"
export {
  createCollection,
  createLiveQueryCollection,
  createOptimisticAction,
  createTransaction,
  deepEquals,
  localOnlyCollectionOptions,
  queryOnce,
  // Comparison operators
  eq,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  // Logical operators
  and,
  or,
  not,
  // Null checking
  isNull,
  isUndefined,
  // Aggregate functions
  count,
  sum,
  avg,
  min,
  max,
  // Includes/projection functions
  concat,
  coalesce,
  toArray,
} from "@tanstack/db"

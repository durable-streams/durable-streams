// Types
export type {
  Operation,
  Value,
  Row,
  ChangeHeaders,
  ChangeEvent,
  ControlEvent,
  StateEvent,
} from "./types"

export { isChangeEvent, isControlEvent } from "./types"

// Classes
export { MaterializedState } from "./materialized-state"

// Stream DB
export { createStreamDB, createStateSchema } from "./stream-db"
export type {
  CollectionDefinition,
  CollectionEventHelpers,
  CollectionWithHelpers,
  StreamStateDefinition,
  StateSchema,
  CreateStreamDBOptions,
  StreamDB,
  StreamDBMethods,
  StreamDBUtils,
  StreamDBWithActions,
  ActionFactory,
  ActionMap,
  ActionDefinition,
} from "./stream-db"

// Re-export key types and utilities from @tanstack/db for convenience
// This ensures consumers can use the same module resolution for type compatibility
export type { Collection, SyncConfig } from "@tanstack/db"
export {
  createCollection,
  createOptimisticAction,
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
} from "@tanstack/db"

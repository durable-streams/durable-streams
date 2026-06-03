// Main entry: the db-free surface of the state protocol.
//
// Everything exported here works without @tanstack/db installed — defining
// schemas, constructing/validating change events, and materializing state
// in-memory. The reactive, TanStack DB-backed StreamDB layer (createStreamDB,
// live queries, optimistic actions) lives under the `@durable-streams/state/db`
// subpath, which carries the `@tanstack/db` peer dependency.

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

// In-memory materialization
export { MaterializedState } from "./materialized-state"

// Schema definition + event construction (producer side)
export { createStateSchema } from "./schema"
export type {
  CollectionDefinition,
  CollectionEventHelpers,
  CollectionWithHelpers,
  StreamStateDefinition,
  StateSchema,
} from "./schema"

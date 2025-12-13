// Based on Electric SQL's type definitions
// https://github.com/electric-sql/electric/blob/main/packages/typescript-client/src/types.ts

/**
 * Operation types for change events
 */
export type Operation = `insert` | `update` | `delete`

/**
 * A generic value type supporting primitives, arrays, and objects
 */
export type Value<Extensions = never> =
  | string
  | number
  | boolean
  | bigint
  | null
  | Array<Value<Extensions>>
  | { [key: string]: Value<Extensions> }
  | Extensions

/**
 * A row is a record of values
 */
export type Row<Extensions = never> = Record<string, Value<Extensions>>

/**
 * Headers for change messages
 */
export type ChangeHeaders = {
  operation: Operation
  txid?: string
  timestamp?: string
}

/**
 * A change event represents a state change event (insert/update/delete)
 */
export type ChangeEvent<T = unknown> = {
  type: string
  key: string
  value?: T
  old_value?: T
  headers: ChangeHeaders
}

/**
 * Control event types for stream management
 */
export type ControlEvent = {
  headers: {
    control: `snapshot-start` | `snapshot-end` | `reset`
    offset?: string
  }
}

/**
 * A state event is either a change event or a control event
 */
export type StateEvent<T = unknown> = ChangeEvent<T> | ControlEvent

/**
 * Type guard to check if an event is a change event
 */
export function isChangeEvent<T = unknown>(
  event: StateEvent<T>
): event is ChangeEvent<T> {
  return `operation` in event.headers
}

/**
 * Type guard to check if an event is a control event
 */
export function isControlEvent<T = unknown>(
  event: StateEvent<T>
): event is ControlEvent {
  return `control` in event.headers
}

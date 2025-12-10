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
 * A change message represents a state change event (insert/update/delete)
 */
export type ChangeMessage<T = unknown> = {
  type: string
  key: string
  value: T
  old_value?: T
  headers: ChangeHeaders
}

/**
 * Control message types for stream management
 */
export type ControlMessage = {
  headers: {
    control: `up-to-date` | `snapshot-start` | `snapshot-end` | `reset`
    offset?: string
  }
}

/**
 * A message is either a change event or a control event
 */
export type Message<T = unknown> = ChangeMessage<T> | ControlMessage

/**
 * Type guard to check if a message is a change event
 */
export function isChangeEvent<T = unknown>(
  msg: Message<T>
): msg is ChangeMessage<T> {
  return `operation` in msg.headers
}

/**
 * Type guard to check if a message is a control event
 */
export function isControlEvent<T = unknown>(
  msg: Message<T>
): msg is ControlMessage {
  return `control` in msg.headers
}

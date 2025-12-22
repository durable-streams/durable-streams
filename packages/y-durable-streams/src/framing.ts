/**
 * Binary framing utilities for Yjs updates.
 *
 * Uses lib0 variable-length encoding (VarUint8Array) to frame updates,
 * which is the standard encoding used throughout the Yjs ecosystem.
 *
 * This framing allows multiple updates to be concatenated in a single stream
 * and parsed back into individual updates.
 */

import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"

/**
 * Frame a Yjs update with a variable-length prefix.
 *
 * @param update - The raw Yjs update bytes
 * @returns The framed update with length prefix
 */
export function frameUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

/**
 * Parse framed updates from a byte stream.
 *
 * @param data - The raw byte data containing framed updates
 * @yields Individual Yjs update bytes (without the length prefix)
 */
export function* parseFramedUpdates(data: Uint8Array): Generator<Uint8Array> {
  const decoder = decoding.createDecoder(data)

  while (decoding.hasContent(decoder)) {
    try {
      yield decoding.readVarUint8Array(decoder)
    } catch (err) {
      console.error(`[y-durable-streams] Failed to parse framed update:`, err)
      break
    }
  }
}

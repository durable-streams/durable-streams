import type { GameEvent } from "./game-state"

/**
 * Parse 3-byte records from binary stream data.
 *
 * Each record is a 24-bit big-endian packed value:
 *   packed = (edgeId << 2) | teamId
 *
 * Where:
 *   - edgeId uses 22 bits (max ~2,002,000)
 *   - teamId uses 2 bits (0-3)
 *
 * Only complete records are parsed. Partial records at the end are ignored.
 */
export function parseStreamRecords(bytes: Uint8Array): Array<GameEvent> {
  const events: Array<GameEvent> = []
  const recordCount = Math.floor(bytes.length / 3)

  for (let i = 0; i < recordCount; i++) {
    const offset = i * 3

    // Big-endian 24-bit packed value
    const packed =
      (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]

    const edgeId = packed >> 2
    const teamId = packed & 0b11

    events.push({ edgeId, teamId })
  }

  return events
}

/**
 * Encode a single game event to 3 bytes.
 *
 * The packed format is:
 *   packed = (edgeId << 2) | teamId
 *
 * Stored as big-endian 24-bit value.
 */
export function encodeEvent(event: GameEvent): Uint8Array {
  const packed = (event.edgeId << 2) | event.teamId
  return new Uint8Array([
    (packed >> 16) & 0xff,
    (packed >> 8) & 0xff,
    packed & 0xff,
  ])
}

/**
 * Streaming parser for incremental stream updates.
 *
 * Handles chunk boundaries correctly by buffering partial records
 * until the next chunk completes them.
 */
export class StreamParser {
  private buffer: Uint8Array = new Uint8Array(0)

  /**
   * Feed bytes and get complete events.
   *
   * Any partial record at the end of the chunk is buffered for the next call.
   */
  feed(chunk: Uint8Array): Array<GameEvent> {
    // Combine with existing buffer
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer)
    combined.set(chunk, this.buffer.length)

    // Parse complete records
    const recordCount = Math.floor(combined.length / 3)
    const completeBytes = recordCount * 3
    const events = parseStreamRecords(combined.subarray(0, completeBytes))

    // Keep remainder in buffer
    this.buffer = combined.slice(completeBytes)

    return events
  }

  /**
   * Get the number of buffered bytes (partial record).
   */
  getBufferedBytes(): number {
    return this.buffer.length
  }

  /**
   * Reset the parser state, discarding any buffered partial record.
   */
  reset(): void {
    this.buffer = new Uint8Array(0)
  }
}

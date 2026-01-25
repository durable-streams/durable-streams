import { isValidEdgeId } from "./edge-math"
import type { GameEvent } from "./types"

const RECORD_BYTES = 3
const MAX_BUFFER_BYTES = RECORD_BYTES - 1

/**
 * Header size in bytes.
 * The first 8 bytes of the stream contain the game start timestamp (ms since epoch).
 */
export const HEADER_BYTES = 8

/**
 * Encode a game start timestamp as an 8-byte header.
 */
export function encodeHeader(timestamp: number): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES)
  // Big-endian 64-bit timestamp
  // JavaScript can safely represent integers up to 2^53, which is enough for timestamps
  const high = Math.floor(timestamp / 0x100000000)
  const low = timestamp >>> 0
  header[0] = (high >> 24) & 0xff
  header[1] = (high >> 16) & 0xff
  header[2] = (high >> 8) & 0xff
  header[3] = high & 0xff
  header[4] = (low >> 24) & 0xff
  header[5] = (low >> 16) & 0xff
  header[6] = (low >> 8) & 0xff
  header[7] = low & 0xff
  return header
}

/**
 * Decode a game start timestamp from an 8-byte header.
 * Returns null if the buffer is too short.
 */
export function decodeHeader(bytes: Uint8Array): number | null {
  if (bytes.length < HEADER_BYTES) return null
  // Big-endian 64-bit timestamp
  const high = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
  const low = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]
  // Combine high and low parts (high * 2^32 + low)
  return high * 0x100000000 + (low >>> 0)
}

function assertValidEvent(event: GameEvent): void {
  if (!isValidEdgeId(event.edgeId)) {
    throw new Error(`Invalid edgeId: ${event.edgeId}`)
  }
  if (!Number.isInteger(event.teamId) || event.teamId < 0 || event.teamId > 3) {
    throw new Error(`Invalid teamId: ${event.teamId}`)
  }
}

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
 *
 * @param bytes - The raw stream bytes
 * @param skipHeader - If true, skips the first HEADER_BYTES before parsing records
 */
export function parseStreamRecords(
  bytes: Uint8Array,
  skipHeader = false
): Array<GameEvent> {
  const events: Array<GameEvent> = []
  const startOffset = skipHeader ? HEADER_BYTES : 0

  if (bytes.length < startOffset) return events

  const dataBytes = bytes.length - startOffset
  const recordCount = Math.floor(dataBytes / RECORD_BYTES)

  for (let i = 0; i < recordCount; i++) {
    const offset = startOffset + i * RECORD_BYTES

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
  assertValidEvent(event)
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
 *
 * The first 8 bytes of the stream are a header containing the game start timestamp.
 */
export class StreamParser {
  private buffer: Uint8Array = new Uint8Array(0)
  private headerParsed = false
  private gameStartTimestamp: number | null = null
  private totalBytesReceived = 0

  /**
   * Feed bytes and get complete events.
   *
   * Any partial record at the end of the chunk is buffered for the next call.
   * The first 8 bytes are parsed as the game start timestamp header.
   */
  feed(chunk: Uint8Array): Array<GameEvent> {
    // Combine with existing buffer
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer)
    combined.set(chunk, this.buffer.length)

    this.totalBytesReceived += chunk.length

    // Track the offset where event data starts in the combined buffer
    let dataStartOffset = 0

    // Parse header if not yet done
    if (!this.headerParsed) {
      if (combined.length < HEADER_BYTES) {
        // Not enough bytes for header yet, buffer everything
        this.buffer = combined
        return []
      }
      // Extract timestamp from header
      this.gameStartTimestamp = decodeHeader(combined)
      this.headerParsed = true
      // Header is in this buffer, skip it for event parsing
      dataStartOffset = HEADER_BYTES
    }
    // If header was already parsed, buffer contains only event bytes (no header to skip)

    // Get event data (skip header if present in this buffer)
    const dataBytes = combined.subarray(dataStartOffset)

    // Parse complete records
    const recordCount = Math.floor(dataBytes.length / RECORD_BYTES)
    const completeBytes = recordCount * RECORD_BYTES
    const events = parseStreamRecords(dataBytes.subarray(0, completeBytes))

    // Keep remainder in buffer (only incomplete record bytes, header already consumed)
    const remainderStart = dataStartOffset + completeBytes
    this.buffer = combined.slice(remainderStart)
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      throw new Error(`Stream parser buffer overflow`)
    }

    return events
  }

  /**
   * Get the game start timestamp from the header.
   * Returns null if the header hasn't been parsed yet.
   */
  getGameStartTimestamp(): number | null {
    return this.gameStartTimestamp
  }

  /**
   * Check if the header has been parsed.
   */
  isHeaderParsed(): boolean {
    return this.headerParsed
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
    this.headerParsed = false
    this.gameStartTimestamp = null
    this.totalBytesReceived = 0
  }
}

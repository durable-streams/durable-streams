/**
 * Binary Frame Parser for Story Stream
 *
 * Frame format:
 * +--------+--------+--------+--------+--------+...+--------+
 * |  Type  |         Length (4 bytes)         |   Payload    |
 * +--------+--------+--------+--------+--------+...+--------+
 *
 * Type (1 byte): Frame type identifier
 * Length (4 bytes): Big-endian uint32, payload length
 * Payload: Variable length data
 */

// Frame type constants
export const FrameType = {
  METADATA: 0x00,
  TEXT: 0x01,
  AUDIO: 0x02,
  END: 0x03,
  ERROR: 0x04,
} as const

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]

// Frame payload types
export interface MetadataPayload {
  prompt: string
}

export interface TextPayload {
  text: string
  isTitle: boolean
}

export interface ErrorPayload {
  error: string
  code: string
}

// Parsed frame types
export interface MetadataFrame {
  type: typeof FrameType.METADATA
  payload: MetadataPayload
}

export interface TextFrame {
  type: typeof FrameType.TEXT
  payload: TextPayload
}

export interface AudioFrame {
  type: typeof FrameType.AUDIO
  payload: Uint8Array
}

export interface EndFrame {
  type: typeof FrameType.END
  payload: null
}

export interface ErrorFrame {
  type: typeof FrameType.ERROR
  payload: ErrorPayload
}

export type Frame =
  | MetadataFrame
  | TextFrame
  | AudioFrame
  | EndFrame
  | ErrorFrame

// Header size: 1 byte type + 4 bytes length
const HEADER_SIZE = 5

// Text encoder/decoder
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Encode a metadata frame
 */
export function encodeMetadataFrame(prompt: string): Uint8Array {
  const payload: MetadataPayload = { prompt }
  const payloadBytes = textEncoder.encode(JSON.stringify(payload))
  return encodeFrame(FrameType.METADATA, payloadBytes)
}

/**
 * Encode a text frame
 */
export function encodeTextFrame(text: string, isTitle: boolean): Uint8Array {
  const payload: TextPayload = { text, isTitle }
  const payloadBytes = textEncoder.encode(JSON.stringify(payload))
  return encodeFrame(FrameType.TEXT, payloadBytes)
}

/**
 * Encode an audio frame
 */
export function encodeAudioFrame(pcmData: Uint8Array): Uint8Array {
  return encodeFrame(FrameType.AUDIO, pcmData)
}

/**
 * Encode an end frame
 */
export function encodeEndFrame(): Uint8Array {
  return encodeFrame(FrameType.END, new Uint8Array(0))
}

/**
 * Encode an error frame
 */
export function encodeErrorFrame(error: string, code: string): Uint8Array {
  const payload: ErrorPayload = { error, code }
  const payloadBytes = textEncoder.encode(JSON.stringify(payload))
  return encodeFrame(FrameType.ERROR, payloadBytes)
}

/**
 * Internal: encode a frame with type and payload
 */
function encodeFrame(type: FrameTypeValue, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + payload.length)

  // Type byte
  frame[0] = type

  // Length (big-endian uint32)
  const length = payload.length
  frame[1] = (length >> 24) & 0xff
  frame[2] = (length >> 16) & 0xff
  frame[3] = (length >> 8) & 0xff
  frame[4] = length & 0xff

  // Payload
  frame.set(payload, HEADER_SIZE)

  return frame
}

/**
 * Parse frames from a buffer
 * Returns parsed frames and any remaining bytes that don't form a complete frame
 */
export function parseFrames(buffer: Uint8Array): {
  frames: Frame[]
  remainder: Uint8Array
} {
  const frames: Frame[] = []
  let offset = 0

  while (offset + HEADER_SIZE <= buffer.length) {
    // Read type
    const type = buffer[offset]

    // Read length (big-endian uint32)
    const length =
      (buffer[offset + 1] << 24) |
      (buffer[offset + 2] << 16) |
      (buffer[offset + 3] << 8) |
      buffer[offset + 4]

    // Check if we have the full payload
    if (offset + HEADER_SIZE + length > buffer.length) {
      break
    }

    // Extract payload
    const payload = buffer.slice(offset + HEADER_SIZE, offset + HEADER_SIZE + length)

    // Parse based on type
    const frame = parseFrame(type, payload)
    if (frame) {
      frames.push(frame)
    }

    offset += HEADER_SIZE + length
  }

  // Return remaining bytes
  const remainder = buffer.slice(offset)

  return { frames, remainder }
}

/**
 * Parse a single frame from type and payload
 */
function parseFrame(type: number, payload: Uint8Array): Frame | null {
  switch (type) {
    case FrameType.METADATA: {
      const json = textDecoder.decode(payload)
      const data = JSON.parse(json) as MetadataPayload
      return { type: FrameType.METADATA, payload: data }
    }

    case FrameType.TEXT: {
      const json = textDecoder.decode(payload)
      const data = JSON.parse(json) as TextPayload
      return { type: FrameType.TEXT, payload: data }
    }

    case FrameType.AUDIO: {
      return { type: FrameType.AUDIO, payload: payload }
    }

    case FrameType.END: {
      return { type: FrameType.END, payload: null }
    }

    case FrameType.ERROR: {
      const json = textDecoder.decode(payload)
      const data = JSON.parse(json) as ErrorPayload
      return { type: FrameType.ERROR, payload: data }
    }

    default:
      console.warn(`Unknown frame type: ${type}`)
      return null
  }
}

/**
 * Concatenate multiple Uint8Arrays
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}


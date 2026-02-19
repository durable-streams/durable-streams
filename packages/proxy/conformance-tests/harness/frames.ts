export interface ParsedFrame {
  type: string
  responseId: number
  payload: Uint8Array
}

export function parseFrames(data: Uint8Array): Array<ParsedFrame> {
  const frames: Array<ParsedFrame> = []
  let offset = 0
  while (offset + 9 <= data.length) {
    const type = String.fromCharCode(data[offset]!)
    const view = new DataView(data.buffer, data.byteOffset + offset, 9)
    const responseId = view.getUint32(1, false)
    const payloadLength = view.getUint32(5, false)
    offset += 9
    if (offset + payloadLength > data.length) break
    const payload = data.slice(offset, offset + payloadLength)
    frames.push({ type, responseId, payload })
    offset += payloadLength
  }
  return frames
}

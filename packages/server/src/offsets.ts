export type ParsedOffset = {
  readonly seq: number
  readonly pos: number
}

const OFFSET_REGEX = /^\d{16}_\d{16}$/
const INITIAL_OFFSET = `0000000000000000_0000000000000000`
const SENTINEL_OFFSET = `-1`

export const initialOffset = (): string => INITIAL_OFFSET

export const isSentinelOffset = (offset: string): boolean =>
  offset === SENTINEL_OFFSET

export const isValidOffset = (offset: string): boolean =>
  offset === SENTINEL_OFFSET || OFFSET_REGEX.test(offset)

export const normalizeOffset = (offset: string): string =>
  offset === SENTINEL_OFFSET ? INITIAL_OFFSET : offset

export const parseOffset = (offset: string): ParsedOffset | null => {
  if (!OFFSET_REGEX.test(offset)) return null
  const [seqStr, posStr] = offset.split(`_`) as [string, string]
  return { seq: Number(seqStr), pos: Number(posStr) }
}

export const formatOffset = (seq: number, pos: number): string => {
  return `${String(seq).padStart(16, `0`)}_${String(pos).padStart(16, `0`)}`
}

export const compareOffsets = (a: string, b: string): -1 | 0 | 1 => {
  const parsedA = parseOffset(a)
  const parsedB = parseOffset(b)
  if (!(parsedA && parsedB)) return 0
  if (parsedA.seq !== parsedB.seq) return parsedA.seq < parsedB.seq ? -1 : 1
  if (parsedA.pos !== parsedB.pos) return parsedA.pos < parsedB.pos ? -1 : 1
  return 0
}

export const advanceOffset = (offset: string, byteCount: number): string => {
  const parsed = parseOffset(offset)
  if (!parsed) return offset
  return formatOffset(parsed.seq, parsed.pos + byteCount)
}

export const incrementSeq = (offset: string): string => {
  const parsed = parseOffset(offset)
  if (!parsed) return offset
  return formatOffset(parsed.seq + 1, parsed.pos)
}

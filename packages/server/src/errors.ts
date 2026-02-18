export class StreamNotFoundError extends Error {
  readonly _tag = `StreamNotFoundError` as const
  readonly path: string

  constructor(path: string) {
    super(`Stream not found: ${path}`)
    this.name = `StreamNotFoundError`
    this.path = path
  }
}

export class StreamConflictError extends Error {
  readonly _tag = `StreamConflictError` as const

  constructor(message: string) {
    super(message)
    this.name = `StreamConflictError`
  }
}

export class SequenceConflictError extends Error {
  readonly _tag = `SequenceConflictError` as const
  readonly expected: string
  readonly received: string

  constructor(expected: string, received: string) {
    super(`Sequence conflict: expected ${expected}, received ${received}`)
    this.name = `SequenceConflictError`
    this.expected = expected
    this.received = received
  }
}

export class ContentTypeMismatchError extends Error {
  readonly _tag = `ContentTypeMismatchError` as const
  readonly expected: string
  readonly received: string

  constructor(expected: string, received: string) {
    super(`Content-Type mismatch: expected ${expected}, received ${received}`)
    this.name = `ContentTypeMismatchError`
    this.expected = expected
    this.received = received
  }
}

export class InvalidJsonError extends Error {
  readonly _tag = `InvalidJsonError` as const

  constructor(message: string) {
    super(message)
    this.name = `InvalidJsonError`
  }
}

export class InvalidOffsetError extends Error {
  readonly _tag = `InvalidOffsetError` as const

  constructor(offset: string) {
    super(`Invalid offset format: ${offset}`)
    this.name = `InvalidOffsetError`
    this.offset = offset
  }

  readonly offset: string
}

export class PayloadTooLargeError extends Error {
  readonly _tag = `PayloadTooLargeError` as const
  readonly maxBytes: number
  readonly receivedBytes: number

  constructor(maxBytes: number, receivedBytes: number) {
    super(
      `Payload too large: max ${maxBytes} bytes, received ${receivedBytes} bytes`
    )
    this.name = `PayloadTooLargeError`
    this.maxBytes = maxBytes
    this.receivedBytes = receivedBytes
  }
}

export type StreamError =
  | StreamNotFoundError
  | StreamConflictError
  | SequenceConflictError
  | ContentTypeMismatchError
  | InvalidJsonError
  | InvalidOffsetError
  | PayloadTooLargeError

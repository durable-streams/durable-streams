import type {
  DurableStreamErrorCode,
  IdempotentProducerErrorCode,
} from "./types"

/**
 * Error thrown for transport/network errors.
 * Following the @electric-sql/client FetchError pattern.
 */
export class FetchError extends Error {
  status: number
  text?: string
  json?: object
  headers: Record<string, string>

  constructor(
    status: number,
    text: string | undefined,
    json: object | undefined,
    headers: Record<string, string>,
    public url: string,
    message?: string
  ) {
    super(
      message ||
        `HTTP Error ${status} at ${url}: ${text ?? JSON.stringify(json)}`
    )
    this.name = `FetchError`
    this.status = status
    this.text = text
    this.json = json
    this.headers = headers
  }

  static async fromResponse(
    response: Response,
    url: string
  ): Promise<FetchError> {
    const status = response.status
    const headers = Object.fromEntries([...response.headers.entries()])
    let text: string | undefined = undefined
    let json: object | undefined = undefined

    const contentType = response.headers.get(`content-type`)
    if (!response.bodyUsed) {
      if (contentType && contentType.includes(`application/json`)) {
        try {
          json = (await response.json()) as object
        } catch {
          // If JSON parsing fails, fall back to text
          text = await response.text()
        }
      } else {
        text = await response.text()
      }
    }

    return new FetchError(status, text, json, headers, url)
  }
}

/**
 * Error thrown when a fetch operation is aborted during backoff.
 */
export class FetchBackoffAbortError extends Error {
  constructor() {
    super(`Fetch with backoff aborted`)
    this.name = `FetchBackoffAbortError`
  }
}

/**
 * Protocol-level error for Durable Streams operations.
 * Provides structured error handling with error codes.
 */
export class DurableStreamError extends Error {
  /**
   * HTTP status code, if applicable.
   */
  status?: number

  /**
   * Structured error code for programmatic handling.
   */
  code: DurableStreamErrorCode

  /**
   * Additional error details (e.g., raw response body).
   */
  details?: unknown

  constructor(
    message: string,
    code: DurableStreamErrorCode,
    status?: number,
    details?: unknown
  ) {
    super(message)
    this.name = `DurableStreamError`
    this.code = code
    this.status = status
    this.details = details
  }

  /**
   * Create a DurableStreamError from an HTTP response.
   */
  static async fromResponse(
    response: Response,
    url: string
  ): Promise<DurableStreamError> {
    const status = response.status
    let details: unknown

    const contentType = response.headers.get(`content-type`)
    if (!response.bodyUsed) {
      if (contentType && contentType.includes(`application/json`)) {
        try {
          details = await response.json()
        } catch {
          details = await response.text()
        }
      } else {
        details = await response.text()
      }
    }

    const code = statusToCode(status)
    const message = `Durable stream error at ${url}: ${response.statusText || status}`

    return new DurableStreamError(message, code, status, details)
  }

  /**
   * Create a DurableStreamError from a FetchError.
   */
  static fromFetchError(error: FetchError): DurableStreamError {
    const code = statusToCode(error.status)
    return new DurableStreamError(
      error.message,
      code,
      error.status,
      error.json ?? error.text
    )
  }
}

/**
 * Map HTTP status codes to DurableStreamErrorCode.
 */
function statusToCode(status: number): DurableStreamErrorCode {
  switch (status) {
    case 400:
      return `BAD_REQUEST`
    case 401:
      return `UNAUTHORIZED`
    case 403:
      return `FORBIDDEN`
    case 404:
      return `NOT_FOUND`
    case 409:
      // Could be CONFLICT_SEQ or CONFLICT_EXISTS depending on context
      // Default to CONFLICT_SEQ, caller can override
      return `CONFLICT_SEQ`
    case 429:
      return `RATE_LIMITED`
    case 503:
      return `BUSY`
    default:
      return `UNKNOWN`
  }
}

/**
 * Error thrown when stream URL is missing.
 */
export class MissingStreamUrlError extends Error {
  constructor() {
    super(`Invalid stream options: missing required url parameter`)
    this.name = `MissingStreamUrlError`
  }
}

/**
 * Error thrown when signal option is invalid.
 */
export class InvalidSignalError extends Error {
  constructor() {
    super(`Invalid signal option. It must be an instance of AbortSignal.`)
    this.name = `InvalidSignalError`
  }
}

/**
 * Error thrown for idempotent producer operations.
 */
export class IdempotentProducerError extends Error {
  /**
   * The error code.
   */
  code: IdempotentProducerErrorCode

  /**
   * HTTP status code.
   */
  status: number

  /**
   * Expected sequence number (for sequence errors).
   */
  expectedSequence?: number

  /**
   * Last committed sequence number (for sequence errors).
   */
  lastSequence?: number

  /**
   * Current epoch (for fencing errors).
   */
  currentEpoch?: number

  constructor(
    message: string,
    code: IdempotentProducerErrorCode,
    status: number,
    details?: {
      expectedSequence?: number
      lastSequence?: number
      currentEpoch?: number
    }
  ) {
    super(message)
    this.name = `IdempotentProducerError`
    this.code = code
    this.status = status
    this.expectedSequence = details?.expectedSequence
    this.lastSequence = details?.lastSequence
    this.currentEpoch = details?.currentEpoch
  }
}

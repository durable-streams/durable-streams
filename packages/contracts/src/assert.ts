/**
 * Contract Assertion Utilities
 *
 * These utilities provide runtime contract checking that can be:
 * - Enabled during testing for validation
 * - Disabled in production for performance
 */

/**
 * Error thrown when a contract is violated
 */
export class ContractViolationError extends Error {
  constructor(
    public readonly contractId: string,
    public readonly message: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(`Contract "${contractId}" violated: ${message}`)
    this.name = `ContractViolationError`
  }
}

/**
 * Assert a condition is true, throwing ContractViolationError if not
 */
export function assert(
  condition: boolean,
  contractId: string,
  message: string,
  context?: Record<string, unknown>
): asserts condition {
  if (!condition) {
    throw new ContractViolationError(contractId, message, context)
  }
}

/**
 * Compare two Uint8Arrays for equality
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Concatenate multiple Uint8Arrays
 */
export function concatBytes(arrays: Array<Uint8Array>): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Compare two offsets lexicographically
 * Returns: negative if a < b, 0 if a === b, positive if a > b
 */
export function compareOffsets(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Encode a string to Uint8Array using UTF-8
 */
export function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

/**
 * Decode a Uint8Array to string using UTF-8
 */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

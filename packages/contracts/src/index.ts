/**
 * @durable-streams/contracts
 *
 * Protocol contracts and invariants for Durable Streams.
 *
 * This package defines the single source of truth for correctness properties
 * that all Durable Streams implementations must satisfy. Contracts can be:
 *
 * - Used in conformance tests to validate protocol compliance
 * - Used in unit tests for runtime assertions
 * - Used to generate property-based tests
 * - Enabled at runtime during development/testing
 *
 * @example
 * ```typescript
 * import { StreamContracts, BackoffContracts } from '@durable-streams/contracts'
 *
 * // Use in a test
 * StreamContracts.OffsetMonotonicity.assert({
 *   prevOffset: "1",
 *   newOffset: "2"
 * })
 *
 * // Iterate all contracts
 * for (const [name, contract] of Object.entries(StreamContracts)) {
 *   console.log(`${contract.id}: ${contract.description}`)
 * }
 * ```
 */

// Assertion utilities
// Re-import for combined export
import { StreamContracts } from "./stream.js"
import { BackoffContracts } from "./backoff.js"

export {
  ContractViolationError,
  assert,
  bytesEqual,
  concatBytes,
  compareOffsets,
  encodeUtf8,
  decodeUtf8,
} from "./assert.js"

// Types
export type {
  Contract,
  ContractAssertFn,
  PropertyGenerator,
  ContractResult,
  ContractCheckOptions,
} from "./types.js"
export { ContractCategories } from "./types.js"

// Stream contracts
export {
  StreamContracts,
  OffsetMonotonicity,
  DataOrdering,
  ByteExactness,
  ResumeFromOffset,
  UpToDate,
  IdempotentCreate,
  ConfigConflict,
  DeleteRemovesData,
  EmptyAppendRejected,
  UnicodePreservation,
  type StreamContractId,
  type OffsetMonotonicityContext,
  type DataOrderingContext,
  type ByteExactnessContext,
  type ResumeFromOffsetContext,
  type UpToDateContext,
  type IdempotentCreateContext,
  type ConfigConflictContext,
  type DeleteRemovesDataContext,
  type EmptyAppendRejectedContext,
  type UnicodePreservationContext,
} from "./stream.js"

// Backoff contracts
export {
  BackoffContracts,
  RetryAfterNonNegative,
  RetryAfterSecondsToMs,
  RetryAfterHttpDateCapped,
  NoRetryOn4xx,
  RetryOn429,
  RetryOn5xx,
  BackoffDelayMonotonic,
  BackoffDelayCapped,
  InitialDelayRespected,
  type BackoffContractId,
  type RetryAfterNonNegativeContext,
  type RetryAfterSecondsToMsContext,
  type RetryAfterHttpDateCappedContext,
  type NoRetryOn4xxContext,
  type RetryOn429Context,
  type RetryOn5xxContext,
  type BackoffDelayMonotonicContext,
  type BackoffDelayCappedContext,
  type InitialDelayRespectedContext,
} from "./backoff.js"

/**
 * All contracts combined for iteration
 */
export const AllContracts: typeof StreamContracts & typeof BackoffContracts = {
  ...StreamContracts,
  ...BackoffContracts,
}

export type AllContractId = keyof typeof AllContracts

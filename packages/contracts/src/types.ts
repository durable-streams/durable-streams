/**
 * Contract Type Definitions
 *
 * These types define the structure of contracts in the Durable Streams protocol.
 */

import type { ContractViolationError } from "./assert.js"

/**
 * Contract assertion function type
 * Takes a context object with the values to check and throws if violated
 */
export type ContractAssertFn<TContext> = (context: TContext) => void

/**
 * Property-based test generator function type
 * Takes fast-check module and returns a property that can be tested
 *
 * Note: We use `unknown` for the fast-check types to avoid requiring
 * fast-check as a dependency. The actual type is:
 * (fc: typeof import("fast-check")) => fc.IPropertyWithHooks<unknown>
 */
export type PropertyGenerator = (fc: unknown) => unknown

/**
 * Contract definition
 */
export interface Contract<TContext = unknown> {
  /** Unique identifier for the contract */
  id: string

  /** Human-readable description of what this contract ensures */
  description: string

  /** Category for grouping related contracts */
  category:
    | `ordering`
    | `consistency`
    | `resumption`
    | `state`
    | `lifecycle`
    | `validation`
    | `encoding`
    | `retry`
    | `backoff`

  /**
   * Runtime assertion function
   * Throws ContractViolationError if the contract is violated
   */
  assert: ContractAssertFn<TContext>

  /**
   * Optional property-based test generator
   * Returns a fast-check property that tests this contract
   */
  property?: PropertyGenerator
}

/**
 * Contract category descriptions
 */
export const ContractCategories = {
  ordering: `Contracts about data and offset ordering`,
  consistency: `Contracts about read/write consistency`,
  resumption: `Contracts about resuming from offsets`,
  state: `Contracts about stream state flags`,
  lifecycle: `Contracts about stream creation/deletion`,
  validation: `Contracts about input validation`,
  encoding: `Contracts about text encoding preservation`,
  retry: `Contracts about retry behavior`,
  backoff: `Contracts about backoff timing`,
} as const

/**
 * Result of running a contract check
 */
export interface ContractResult {
  contractId: string
  passed: boolean
  error?: ContractViolationError
  duration?: number
}

/**
 * Options for contract checking
 */
export interface ContractCheckOptions {
  /** Whether to throw on first violation or collect all */
  throwOnViolation?: boolean

  /** Optional timeout for contract checks */
  timeoutMs?: number
}

/**
 * Retry and Backoff Contracts
 *
 * These define the invariants for retry behavior and exponential backoff
 * in the Durable Streams client. Extracted from property-based tests to
 * serve as the single source of truth.
 */

import { assert } from "./assert.js"
import type { Contract, ContractAssertFn } from "./types.js"

// ============================================================================
// Contract: Retry-After Non-Negative
// ============================================================================

export interface RetryAfterNonNegativeContext {
  headerValue: string
  parsedMs: number
}

const retryAfterNonNegativeAssert: ContractAssertFn<
  RetryAfterNonNegativeContext
> = (ctx) => {
  assert(
    ctx.parsedMs >= 0,
    `retry-after-non-negative`,
    `Parsed Retry-After value must be non-negative`,
    { headerValue: ctx.headerValue, parsedMs: ctx.parsedMs }
  )
}

/**
 * CONTRACT: Retry-After Non-Negative
 *
 * The parseRetryAfterHeader function must always return a non-negative number.
 * Invalid inputs default to 0, not negative values.
 *
 * Invariant: parseRetryAfterHeader(any) >= 0
 */
export const RetryAfterNonNegative: Contract<RetryAfterNonNegativeContext> = {
  id: `retry-after-non-negative`,
  description: `Parsed Retry-After is always non-negative`,
  category: `retry`,
  assert: retryAfterNonNegativeAssert,
}

// ============================================================================
// Contract: Retry-After Seconds To Milliseconds
// ============================================================================

export interface RetryAfterSecondsToMsContext {
  seconds: number
  parsedMs: number
}

const retryAfterSecondsToMsAssert: ContractAssertFn<
  RetryAfterSecondsToMsContext
> = (ctx) => {
  assert(
    ctx.parsedMs === ctx.seconds * 1000,
    `retry-after-seconds-to-ms`,
    `Retry-After in seconds must be converted to milliseconds`,
    {
      seconds: ctx.seconds,
      expectedMs: ctx.seconds * 1000,
      parsedMs: ctx.parsedMs,
    }
  )
}

/**
 * CONTRACT: Retry-After Seconds To Milliseconds
 *
 * When Retry-After header contains a positive integer (seconds),
 * it must be converted to milliseconds correctly.
 *
 * Invariant: parseRetryAfterHeader(N) === N * 1000 for positive integer N
 */
export const RetryAfterSecondsToMs: Contract<RetryAfterSecondsToMsContext> = {
  id: `retry-after-seconds-to-ms`,
  description: `Seconds are correctly converted to milliseconds`,
  category: `retry`,
  assert: retryAfterSecondsToMsAssert,
}

// ============================================================================
// Contract: Retry-After HTTP-Date Capped
// ============================================================================

export interface RetryAfterHttpDateCappedContext {
  httpDate: string
  parsedMs: number
  maxMs: number
}

const retryAfterHttpDateCappedAssert: ContractAssertFn<
  RetryAfterHttpDateCappedContext
> = (ctx) => {
  assert(
    ctx.parsedMs <= ctx.maxMs,
    `retry-after-http-date-capped`,
    `HTTP-date Retry-After must be capped to maximum`,
    { parsedMs: ctx.parsedMs, maxMs: ctx.maxMs }
  )
}

/**
 * CONTRACT: Retry-After HTTP-Date Capped
 *
 * When Retry-After contains an HTTP-date far in the future,
 * the delay must be capped to a reasonable maximum (1 hour).
 *
 * Invariant: parseRetryAfterHeader(futureDate) <= 3600000
 */
export const RetryAfterHttpDateCapped: Contract<RetryAfterHttpDateCappedContext> =
  {
    id: `retry-after-http-date-capped`,
    description: `HTTP-date delays are capped to 1 hour`,
    category: `retry`,
    assert: retryAfterHttpDateCappedAssert,
  }

// ============================================================================
// Contract: No Retry On 4xx (Except 429)
// ============================================================================

export interface NoRetryOn4xxContext {
  statusCode: number
  retryAttempts: number
}

const noRetryOn4xxAssert: ContractAssertFn<NoRetryOn4xxContext> = (ctx) => {
  if (ctx.statusCode >= 400 && ctx.statusCode < 500 && ctx.statusCode !== 429) {
    assert(
      ctx.retryAttempts === 0,
      `no-retry-on-4xx`,
      `4xx errors (except 429) must not trigger retry`,
      { statusCode: ctx.statusCode, retryAttempts: ctx.retryAttempts }
    )
  }
}

/**
 * CONTRACT: No Retry On 4xx (Except 429)
 *
 * Client errors (4xx) except for 429 (Too Many Requests) should not
 * trigger retry attempts. These are permanent failures.
 *
 * Invariant: 4xx (except 429) => retryAttempts === 0
 */
export const NoRetryOn4xx: Contract<NoRetryOn4xxContext> = {
  id: `no-retry-on-4xx`,
  description: `4xx errors (except 429) do not retry`,
  category: `retry`,
  assert: noRetryOn4xxAssert,
}

// ============================================================================
// Contract: Retry On 429
// ============================================================================

export interface RetryOn429Context {
  statusCode: number
  didRetry: boolean
}

const retryOn429Assert: ContractAssertFn<RetryOn429Context> = (ctx) => {
  if (ctx.statusCode === 429) {
    assert(
      ctx.didRetry,
      `retry-on-429`,
      `429 Too Many Requests must trigger retry`,
      { statusCode: ctx.statusCode }
    )
  }
}

/**
 * CONTRACT: Retry On 429
 *
 * 429 Too Many Requests must trigger retry with appropriate backoff.
 * This is distinct from other 4xx errors.
 *
 * Invariant: 429 => didRetry === true
 */
export const RetryOn429: Contract<RetryOn429Context> = {
  id: `retry-on-429`,
  description: `429 errors trigger retry`,
  category: `retry`,
  assert: retryOn429Assert,
}

// ============================================================================
// Contract: Retry On 5xx
// ============================================================================

export interface RetryOn5xxContext {
  statusCode: number
  didRetry: boolean
}

const retryOn5xxAssert: ContractAssertFn<RetryOn5xxContext> = (ctx) => {
  if (ctx.statusCode >= 500 && ctx.statusCode < 600) {
    assert(
      ctx.didRetry,
      `retry-on-5xx`,
      `5xx server errors must trigger retry`,
      { statusCode: ctx.statusCode }
    )
  }
}

/**
 * CONTRACT: Retry On 5xx
 *
 * Server errors (5xx) are transient and should trigger retry attempts.
 *
 * Invariant: 5xx => didRetry === true
 */
export const RetryOn5xx: Contract<RetryOn5xxContext> = {
  id: `retry-on-5xx`,
  description: `5xx errors trigger retry`,
  category: `retry`,
  assert: retryOn5xxAssert,
}

// ============================================================================
// Contract: Backoff Delay Monotonic
// ============================================================================

export interface BackoffDelayMonotonicContext {
  delays: Array<number>
}

const backoffDelayMonotonicAssert: ContractAssertFn<
  BackoffDelayMonotonicContext
> = (ctx) => {
  for (let i = 1; i < ctx.delays.length; i++) {
    const prev = ctx.delays[i - 1]!
    const curr = ctx.delays[i]!
    assert(
      curr >= prev,
      `backoff-delay-monotonic`,
      `Backoff delays must be monotonically non-decreasing`,
      { index: i, prevDelay: prev, currDelay: curr }
    )
  }
}

/**
 * CONTRACT: Backoff Delay Monotonic
 *
 * Each successive retry delay must be greater than or equal to the previous.
 * Delays increase exponentially until capped at maxDelay.
 *
 * Invariant: delay[n+1] >= delay[n] for all n
 */
export const BackoffDelayMonotonic: Contract<BackoffDelayMonotonicContext> = {
  id: `backoff-delay-monotonic`,
  description: `Backoff delays are monotonically non-decreasing`,
  category: `backoff`,
  assert: backoffDelayMonotonicAssert,
}

// ============================================================================
// Contract: Backoff Delay Capped
// ============================================================================

export interface BackoffDelayCappedContext {
  delay: number
  maxDelay: number
}

const backoffDelayCappedAssert: ContractAssertFn<BackoffDelayCappedContext> = (
  ctx
) => {
  assert(
    ctx.delay <= ctx.maxDelay,
    `backoff-delay-capped`,
    `Backoff delay must not exceed maxDelay`,
    { delay: ctx.delay, maxDelay: ctx.maxDelay }
  )
}

/**
 * CONTRACT: Backoff Delay Capped
 *
 * No backoff delay may exceed the configured maxDelay, regardless
 * of retry count or multiplier.
 *
 * Invariant: delay <= maxDelay for all retries
 */
export const BackoffDelayCapped: Contract<BackoffDelayCappedContext> = {
  id: `backoff-delay-capped`,
  description: `Backoff delays never exceed maxDelay`,
  category: `backoff`,
  assert: backoffDelayCappedAssert,
}

// ============================================================================
// Contract: Initial Delay Respected
// ============================================================================

export interface InitialDelayRespectedContext {
  firstDelay: number
  initialDelay: number
  maxDelay: number
}

const initialDelayRespectedAssert: ContractAssertFn<
  InitialDelayRespectedContext
> = (ctx) => {
  const expected = Math.min(ctx.initialDelay, ctx.maxDelay)
  assert(
    ctx.firstDelay === expected,
    `initial-delay-respected`,
    `First delay must equal initialDelay (capped by maxDelay)`,
    {
      firstDelay: ctx.firstDelay,
      initialDelay: ctx.initialDelay,
      maxDelay: ctx.maxDelay,
      expected,
    }
  )
}

/**
 * CONTRACT: Initial Delay Respected
 *
 * The first retry delay must equal initialDelay (or maxDelay if smaller).
 *
 * Invariant: delay[0] === min(initialDelay, maxDelay)
 */
export const InitialDelayRespected: Contract<InitialDelayRespectedContext> = {
  id: `initial-delay-respected`,
  description: `First delay equals initialDelay`,
  category: `backoff`,
  assert: initialDelayRespectedAssert,
}

// ============================================================================
// Export All Backoff Contracts
// ============================================================================

/**
 * All retry and backoff contracts as a single object.
 */
export const BackoffContracts: {
  readonly RetryAfterNonNegative: Contract<RetryAfterNonNegativeContext>
  readonly RetryAfterSecondsToMs: Contract<RetryAfterSecondsToMsContext>
  readonly RetryAfterHttpDateCapped: Contract<RetryAfterHttpDateCappedContext>
  readonly NoRetryOn4xx: Contract<NoRetryOn4xxContext>
  readonly RetryOn429: Contract<RetryOn429Context>
  readonly RetryOn5xx: Contract<RetryOn5xxContext>
  readonly BackoffDelayMonotonic: Contract<BackoffDelayMonotonicContext>
  readonly BackoffDelayCapped: Contract<BackoffDelayCappedContext>
  readonly InitialDelayRespected: Contract<InitialDelayRespectedContext>
} = {
  RetryAfterNonNegative,
  RetryAfterSecondsToMs,
  RetryAfterHttpDateCapped,
  NoRetryOn4xx,
  RetryOn429,
  RetryOn5xx,
  BackoffDelayMonotonic,
  BackoffDelayCapped,
  InitialDelayRespected,
}

export type BackoffContractId = keyof typeof BackoffContracts

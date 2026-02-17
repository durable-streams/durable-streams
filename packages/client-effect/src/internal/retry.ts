/**
 * Retry scheduling utilities with exponential backoff.
 */
import { Duration, Effect, Schedule } from "effect"

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /**
   * Maximum number of retries (default 3).
   */
  readonly maxRetries?: number

  /**
   * Initial delay in milliseconds (default 100).
   */
  readonly initialDelayMs?: number

  /**
   * Maximum delay in milliseconds (default 10000).
   */
  readonly maxDelayMs?: number

  /**
   * Backoff multiplier (default 2).
   */
  readonly multiplier?: number

  /**
   * Jitter factor 0-1 (default 0.1).
   */
  readonly jitter?: number
}

/**
 * Default retry options.
 */
export const DefaultRetryOptions: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 10000,
  multiplier: 2,
  jitter: 0.1,
}

/**
 * Create a retry schedule with exponential backoff and jitter.
 */
export const makeRetrySchedule = (options: RetryOptions = {}) => {
  const opts = { ...DefaultRetryOptions, ...options }

  // Exponential backoff with jitter, limited retries
  return Schedule.exponential(
    Duration.millis(opts.initialDelayMs),
    opts.multiplier
  ).pipe(
    Schedule.jittered,
    Schedule.whileOutput((duration) =>
      Duration.lessThanOrEqualTo(duration, Duration.millis(opts.maxDelayMs))
    ),
    Schedule.intersect(Schedule.recurs(opts.maxRetries))
  )
}

/**
 * Check if an HTTP status code should trigger a retry.
 */
export const isRetryableStatus = (status: number): boolean => {
  // 429 Too Many Requests
  if (status === 429) return true
  // 5xx Server Errors
  if (status >= 500 && status < 600) return true
  return false
}

/**
 * Retry an effect with exponential backoff for retryable errors.
 */
export const retryWithBackoff = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: RetryOptions = {},
  shouldRetry: (error: E) => boolean = () => true
): Effect.Effect<A, E, R> =>
  Effect.retry(
    effect,
    Schedule.whileInput(makeRetrySchedule(options), shouldRetry)
  )

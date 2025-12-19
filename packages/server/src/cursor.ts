/**
 * Stream cursor calculation for CDN cache collapsing.
 *
 * This module implements interval-based cursor generation to prevent
 * infinite CDN cache loops while enabling request collapsing.
 *
 * The mechanism works by:
 * 1. Dividing time into fixed intervals (default 20 seconds)
 * 2. Computing interval number from an epoch (October 9, 2024)
 * 3. Returning cursor values that change at interval boundaries
 * 4. Ensuring monotonic cursor progression (never going backwards)
 */

/**
 * Default epoch for cursor calculation: October 9, 2024 00:00:00 UTC.
 * This is the reference point from which intervals are counted.
 * Using a past date ensures cursors are always positive.
 */
export const DEFAULT_CURSOR_EPOCH: Date = new Date(`2024-10-09T00:00:00.000Z`)

/**
 * Default interval duration in seconds.
 */
export const DEFAULT_CURSOR_INTERVAL_SECONDS = 20

/**
 * Maximum jitter in seconds to add on collision.
 * Per protocol spec: random value between 1-3600 seconds.
 */
const MAX_JITTER_SECONDS = 3600

/**
 * Minimum jitter in seconds.
 */
const MIN_JITTER_SECONDS = 1

/**
 * Configuration options for cursor calculation.
 */
export interface CursorOptions {
  /**
   * Interval duration in seconds.
   * Default: 20 seconds.
   */
  intervalSeconds?: number

  /**
   * Epoch timestamp for interval calculation.
   * Default: October 9, 2024 00:00:00 UTC.
   */
  epoch?: Date
}

/**
 * Calculate the current cursor value based on time intervals.
 *
 * @param options - Configuration for cursor calculation
 * @returns The current cursor value as a string
 */
export function calculateCursor(options: CursorOptions = {}): string {
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const epoch = options.epoch ?? DEFAULT_CURSOR_EPOCH

  const now = Date.now()
  const epochMs = epoch.getTime()
  const intervalMs = intervalSeconds * 1000

  // Calculate interval number since epoch
  const intervalNumber = Math.floor((now - epochMs) / intervalMs)

  return String(intervalNumber)
}

/**
 * Generate a random jitter value in intervals.
 *
 * @param intervalSeconds - The interval duration in seconds
 * @returns Number of intervals to add as jitter
 */
function generateJitterIntervals(intervalSeconds: number): number {
  // Add random jitter: 1-3600 seconds
  const jitterSeconds =
    MIN_JITTER_SECONDS +
    Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1))

  // Calculate how many intervals the jitter represents (at least 1)
  return Math.max(1, Math.ceil(jitterSeconds / intervalSeconds))
}

/**
 * Generate a cursor for a response, ensuring monotonic progression.
 *
 * This function ensures the returned cursor is always greater than or equal
 * to the current time interval, and strictly greater than any client-provided
 * cursor. This prevents cache loops where a client could cycle between
 * cursor values.
 *
 * Algorithm:
 * - If no client cursor: return current interval
 * - If client cursor < current interval: return current interval
 * - If client cursor >= current interval: return client cursor + jitter
 *
 * This guarantees monotonic cursor progression and prevents A→B→A cycles.
 *
 * @param clientCursor - The cursor provided by the client (if any)
 * @param options - Configuration for cursor calculation
 * @returns The cursor value to include in the response
 */
export function generateResponseCursor(
  clientCursor: string | undefined,
  options: CursorOptions = {}
): string {
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const currentCursor = calculateCursor(options)
  const currentInterval = parseInt(currentCursor, 10)

  // No client cursor - return current interval
  if (!clientCursor) {
    return currentCursor
  }

  // Parse client cursor
  const clientInterval = parseInt(clientCursor, 10)

  // If client cursor is invalid or behind current time, return current interval
  if (isNaN(clientInterval) || clientInterval < currentInterval) {
    return currentCursor
  }

  // Client cursor is at or ahead of current interval - add jitter to advance
  // This ensures we never return a cursor <= what the client sent
  const jitterIntervals = generateJitterIntervals(intervalSeconds)
  return String(clientInterval + jitterIntervals)
}

/**
 * Handle cursor collision by adding random jitter.
 *
 * @deprecated Use generateResponseCursor instead, which handles all cases
 * including monotonicity guarantees.
 *
 * @param currentCursor - The newly calculated cursor value
 * @param previousCursor - The cursor provided by the client (if any)
 * @param options - Configuration for cursor calculation
 * @returns The cursor value to return, with jitter applied if there's a collision
 */
export function handleCursorCollision(
  currentCursor: string,
  previousCursor: string | undefined,
  options: CursorOptions = {}
): string {
  // Delegate to the new implementation for backwards compatibility
  return generateResponseCursor(previousCursor, options)
}

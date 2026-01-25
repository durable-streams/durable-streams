/**
 * Stream cursor calculation for CDN cache collapsing.
 */

/**
 * Default epoch for cursor calculation: October 9, 2024 00:00:00 UTC.
 */
export const DEFAULT_CURSOR_EPOCH: Date = new Date("2024-10-09T00:00:00.000Z")

/**
 * Default interval duration in seconds.
 */
export const DEFAULT_CURSOR_INTERVAL_SECONDS: number = 20

/**
 * Maximum jitter in seconds to add on collision.
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
  intervalSeconds?: number
  epoch?: Date
}

/**
 * Calculate the current cursor value based on time intervals.
 */
export function calculateCursor(options: CursorOptions = {}): string {
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const epoch = options.epoch ?? DEFAULT_CURSOR_EPOCH

  const now = Date.now()
  const epochMs = epoch.getTime()
  const intervalMs = intervalSeconds * 1000

  const intervalNumber = Math.floor((now - epochMs) / intervalMs)

  return String(intervalNumber)
}

/**
 * Generate a random jitter value in intervals.
 */
function generateJitterIntervals(intervalSeconds: number): number {
  const jitterSeconds =
    MIN_JITTER_SECONDS +
    Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1))

  return Math.max(1, Math.ceil(jitterSeconds / intervalSeconds))
}

/**
 * Generate a cursor for a response, ensuring monotonic progression.
 */
export function generateResponseCursor(
  clientCursor: string | undefined,
  options: CursorOptions = {}
): string {
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const currentCursor = calculateCursor(options)
  const currentInterval = parseInt(currentCursor, 10)

  if (!clientCursor) {
    return currentCursor
  }

  const clientInterval = parseInt(clientCursor, 10)

  if (isNaN(clientInterval) || clientInterval < currentInterval) {
    return currentCursor
  }

  const jitterIntervals = generateJitterIntervals(intervalSeconds)
  return String(clientInterval + jitterIntervals)
}

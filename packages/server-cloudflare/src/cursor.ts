/**
 * Stream cursor calculation for CDN cache collapsing.
 *
 * Ported from the Durable Streams reference server
 * (packages/server/src/cursor.ts, Apache-2.0, Durable Stream contributors).
 *
 * Time is divided into fixed intervals counted from a fixed epoch; cursor
 * values change at interval boundaries and progress monotonically (a client
 * cursor at or ahead of the current interval gets random jitter added) so
 * CDN caches can collapse requests without A->B->A cache loops.
 */

/** Reference point for interval counting; a past date keeps cursors positive. */
export const DEFAULT_CURSOR_EPOCH_MS = Date.UTC(2024, 9, 9, 0, 0, 0);

export const DEFAULT_CURSOR_INTERVAL_SECONDS = 20;

/** Per protocol spec: jitter is a random value between 1-3600 seconds. */
const MAX_JITTER_SECONDS = 3600;
const MIN_JITTER_SECONDS = 1;

export function calculateCursor(): string {
  const intervalMs = DEFAULT_CURSOR_INTERVAL_SECONDS * 1000;
  const intervalNumber = Math.floor(
    (Date.now() - DEFAULT_CURSOR_EPOCH_MS) / intervalMs,
  );
  return String(intervalNumber);
}

function generateJitterIntervals(intervalSeconds: number): number {
  const jitterSeconds =
    MIN_JITTER_SECONDS +
    Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1));
  return Math.max(1, Math.ceil(jitterSeconds / intervalSeconds));
}

/**
 * Generate a response cursor that is >= the current interval and strictly
 * greater than any client-provided cursor.
 */
/**
 * Cursors we emit are small decimal interval counters; only accept the
 * same shape back. Anything else (huge digit strings that parse to
 * Infinity, exponents, garbage) is treated as no-cursor so we can never
 * be steered into emitting a non-numeric or non-monotonic cursor.
 */
const VALID_CLIENT_CURSOR = /^\d{1,15}$/;

export function generateResponseCursor(
  clientCursor: string | undefined,
): string {
  const currentCursor = calculateCursor();
  if (!clientCursor || !VALID_CLIENT_CURSOR.test(clientCursor)) {
    return currentCursor;
  }

  const clientInterval = parseInt(clientCursor, 10);
  const currentInterval = parseInt(currentCursor, 10);
  if (Number.isNaN(clientInterval) || clientInterval < currentInterval) {
    return currentCursor;
  }

  const jitterIntervals = generateJitterIntervals(
    DEFAULT_CURSOR_INTERVAL_SECONDS,
  );
  return String(clientInterval + jitterIntervals);
}

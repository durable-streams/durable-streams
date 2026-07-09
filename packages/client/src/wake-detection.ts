export interface WakeDetectionOptions {
  onWake: () => void
  intervalMs?: number
  thresholdMs?: number
}

const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_THRESHOLD_MS = 4000

function isBrowser(): boolean {
  return (
    typeof document === `object` &&
    typeof document.hidden === `boolean` &&
    typeof document.addEventListener === `function`
  )
}

export function subscribeToWakeDetection(
  options: WakeDetectionOptions
): () => void {
  if (isBrowser()) {
    return () => {}
  }

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS
  let lastTick = Date.now()

  const timer = setInterval(() => {
    const now = Date.now()
    const elapsed = now - lastTick
    lastTick = now

    if (elapsed > intervalMs + thresholdMs) {
      options.onWake()
    }
  }, intervalMs)

  if (typeof timer === `object` && `unref` in timer) {
    timer.unref()
  }

  return () => {
    clearInterval(timer)
  }
}

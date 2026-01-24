import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import {
  MAX_QUOTA,
  QUOTA_REFILL_INTERVAL_MS,
  QUOTA_STORAGE_KEY,
} from "../lib/config"
import type { ReactNode } from "react"

// Re-export for backward compatibility
export { MAX_QUOTA }
export const QUOTA_KEY = QUOTA_STORAGE_KEY
export const REFILL_INTERVAL_MS = QUOTA_REFILL_INTERVAL_MS

export interface QuotaState {
  remaining: number
  lastRefillAt: number
  version: number
}

export interface QuotaContextValue {
  /** Current remaining quota tokens */
  remaining: number
  /** Maximum quota tokens */
  max: number
  /** Seconds until next refill (0 if full) */
  refillIn: number
  /** Number of bonus tokens earned (for toast animation), resets after reading */
  bonusCount: number
  /** Clear the bonus count after showing toast */
  clearBonus: () => void
  /** Optimistically consume a token. Returns false if no tokens available. */
  consume: () => boolean
  /** Sync quota state from server response. Use this instead of manual refunds. */
  syncFromServer: (
    remaining: number,
    refillIn?: number,
    boxesClaimed?: number
  ) => void
  /** Legacy refund for error cases where server doesn't respond */
  refund: () => void
}

const QuotaContext = createContext<QuotaContextValue | null>(null)

function loadQuota(): QuotaState {
  try {
    const stored = localStorage.getItem(QUOTA_KEY)
    if (stored) {
      const state = JSON.parse(stored) as QuotaState

      // Calculate refills since last visit
      const now = Date.now()
      const elapsed = now - state.lastRefillAt
      const refills = Math.floor(elapsed / REFILL_INTERVAL_MS)

      if (refills > 0) {
        state.remaining = Math.min(MAX_QUOTA, state.remaining + refills)
        state.lastRefillAt += refills * REFILL_INTERVAL_MS
      }

      return state
    }
  } catch {
    // Ignore parse errors
  }

  return {
    remaining: MAX_QUOTA,
    lastRefillAt: Date.now(),
    version: 1,
  }
}

function saveQuota(state: QuotaState): void {
  localStorage.setItem(QUOTA_KEY, JSON.stringify(state))
}

export function QuotaProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<QuotaState>(() => loadQuota())
  const [refillIn, setRefillIn] = useState(0)
  const [bonusCount, setBonusCount] = useState(0)

  // Persist to localStorage
  useEffect(() => {
    saveQuota(state)
  }, [state])

  // Refill timer - check every 1 second
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      const elapsed = now - state.lastRefillAt
      const refills = Math.floor(elapsed / REFILL_INTERVAL_MS)

      if (refills > 0 && state.remaining < MAX_QUOTA) {
        setState((s) => ({
          ...s,
          remaining: Math.min(MAX_QUOTA, s.remaining + refills),
          lastRefillAt: s.lastRefillAt + refills * REFILL_INTERVAL_MS,
        }))
      }

      // Calculate time until next refill
      const timeSinceLastRefill = now - state.lastRefillAt
      const timeUntilNext = Math.max(
        0,
        REFILL_INTERVAL_MS - timeSinceLastRefill
      )
      setRefillIn(Math.ceil(timeUntilNext / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [state.lastRefillAt, state.remaining])

  // Cross-tab sync via storage event
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === QUOTA_KEY && e.newValue) {
        setState(JSON.parse(e.newValue))
      }
    }

    window.addEventListener(`storage`, handler)
    return () => window.removeEventListener(`storage`, handler)
  }, [])

  // Optimistically consume a token (called before server request)
  const consume = useCallback(() => {
    if (state.remaining <= 0) return false

    setState((s) => ({
      ...s,
      remaining: s.remaining - 1,
    }))

    return true
  }, [state.remaining])

  // Sync quota from server response (includes any refunds for completed boxes)
  const syncFromServer = useCallback(
    (remaining: number, serverRefillIn?: number, boxesClaimed?: number) => {
      const now = Date.now()

      // Track bonus for toast animation
      if (boxesClaimed && boxesClaimed > 0) {
        setBonusCount(boxesClaimed)
      }

      // Calculate lastRefillAt to align with server's refillIn
      // This ensures the interval timer computes the same countdown
      let newLastRefillAt: number
      if (serverRefillIn !== undefined && serverRefillIn > 0) {
        // Server says "next refill in X seconds"
        // So lastRefillAt should be: now - (interval - X*1000)
        // Clamp serverRefillIn to interval to prevent future timestamps
        const clampedRefillMs = Math.min(
          serverRefillIn * 1000,
          REFILL_INTERVAL_MS
        )
        newLastRefillAt = now - (REFILL_INTERVAL_MS - clampedRefillMs)
        setRefillIn(Math.floor(clampedRefillMs / 1000))
      } else {
        // No server refillIn or quota is full (refillIn=0)
        // Keep current timing or reset to now
        newLastRefillAt = now
        if (remaining >= MAX_QUOTA) {
          setRefillIn(0)
        }
      }

      setState((s) => ({
        ...s,
        remaining: Math.min(MAX_QUOTA, Math.max(0, remaining)),
        lastRefillAt: newLastRefillAt,
      }))
    },
    []
  )

  // Clear bonus count after toast is shown
  const clearBonus = useCallback(() => {
    setBonusCount(0)
  }, [])

  // Legacy refund for network errors where server doesn't respond
  const refund = useCallback(() => {
    setState((s) => ({
      ...s,
      remaining: Math.min(MAX_QUOTA, s.remaining + 1),
    }))
  }, [])

  return (
    <QuotaContext.Provider
      value={{
        remaining: state.remaining,
        max: MAX_QUOTA,
        refillIn,
        bonusCount,
        clearBonus,
        consume,
        syncFromServer,
        refund,
      }}
    >
      {children}
    </QuotaContext.Provider>
  )
}

export function useQuota(): QuotaContextValue {
  const ctx = useContext(QuotaContext)
  if (!ctx) {
    throw new Error(`useQuota must be used within QuotaProvider`)
  }
  return ctx
}

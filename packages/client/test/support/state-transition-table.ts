/**
 * Exhaustive state transition truth table for the 7-state stream response
 * state machine. The `Record` types ensure the compiler rejects missing cells.
 *
 * See SPEC.md for the authoritative specification.
 */

export type StateKind =
  | `initial`
  | `syncing`
  | `stale-retry`
  | `live`
  | `replaying`
  | `paused`
  | `error`

export type EventType =
  | `response`
  | `messages`
  | `messagesUtd`
  | `sseClose`
  | `pause`
  | `resume`
  | `error`
  | `retry`
  | `enterReplayMode`

export interface ExpectedBehavior {
  /** The expected kind of the resulting state, or "same" meaning returns `this` */
  readonly resultKind: StateKind | `same`
  /** If true, expect reference equality: result === input */
  readonly sameReference?: boolean
  /** For response transitions, the expected action field */
  readonly action?: `accepted` | `ignored`
  /** Whether this event is not applicable (method doesn't exist on this state) */
  readonly notApplicable?: boolean
  /** Additional notes for documentation */
  readonly note?: string
}

/**
 * Complete transition table — 7 states x 9 events = 63 cells.
 * No `Partial` — the compiler enforces every cell is filled.
 */
export const TRANSITION_TABLE: Record<
  StateKind,
  Record<EventType, ExpectedBehavior>
> = {
  initial: {
    response: {
      resultKind: `syncing`,
      action: `accepted`,
    },
    messages: {
      resultKind: `same`,
      sameReference: true,
      note: `no upToDate message, stays initial`,
    },
    messagesUtd: {
      resultKind: `same`,
      sameReference: true,
      note: `InitialState does not handle upToDate specially (inherits ActiveState default)`,
    },
    sseClose: {
      resultKind: `same`,
      sameReference: true,
      note: `non-live state, sseClose is a no-op`,
    },
    pause: {
      resultKind: `paused`,
    },
    resume: {
      resultKind: `same`,
      notApplicable: true,
      note: `resume() only exists on PausedState`,
    },
    error: {
      resultKind: `error`,
    },
    retry: {
      resultKind: `same`,
      notApplicable: true,
      note: `retry() only exists on ErrorState`,
    },
    enterReplayMode: {
      resultKind: `replaying`,
      note: `canEnterReplayMode() → true`,
    },
  },

  syncing: {
    response: {
      resultKind: `syncing`,
      action: `accepted`,
    },
    messages: {
      resultKind: `same`,
      sameReference: true,
      note: `no upToDate message, stays syncing`,
    },
    messagesUtd: {
      resultKind: `live`,
      note: `hasUpToDateMessage → transitions to LiveState`,
    },
    sseClose: {
      resultKind: `same`,
      sameReference: true,
      note: `non-live state, sseClose is a no-op`,
    },
    pause: {
      resultKind: `paused`,
    },
    resume: {
      resultKind: `same`,
      notApplicable: true,
    },
    error: {
      resultKind: `error`,
    },
    retry: {
      resultKind: `same`,
      notApplicable: true,
    },
    enterReplayMode: {
      resultKind: `replaying`,
      note: `canEnterReplayMode() → true`,
    },
  },

  "stale-retry": {
    response: {
      resultKind: `syncing`,
      action: `accepted`,
    },
    messages: {
      resultKind: `same`,
      sameReference: true,
      note: `inherits ActiveState default — no upToDate handling`,
    },
    messagesUtd: {
      resultKind: `same`,
      sameReference: true,
      note: `StaleRetryState inherits FetchingState which inherits ActiveState default`,
    },
    sseClose: {
      resultKind: `same`,
      sameReference: true,
    },
    pause: {
      resultKind: `paused`,
    },
    resume: {
      resultKind: `same`,
      notApplicable: true,
    },
    error: {
      resultKind: `error`,
    },
    retry: {
      resultKind: `same`,
      notApplicable: true,
    },
    enterReplayMode: {
      resultKind: `same`,
      notApplicable: true,
      note: `canEnterReplayMode() → false`,
    },
  },

  live: {
    response: {
      resultKind: `live`,
      action: `accepted`,
      note: `preserves SSE tracking fields`,
    },
    messages: {
      resultKind: `live`,
      note: `returns new LiveState preserving SSE tracking`,
    },
    messagesUtd: {
      resultKind: `live`,
      note: `already live, stays live`,
    },
    sseClose: {
      resultKind: `live`,
      note: `updates short-connection tracking`,
    },
    pause: {
      resultKind: `paused`,
    },
    resume: {
      resultKind: `same`,
      notApplicable: true,
    },
    error: {
      resultKind: `error`,
    },
    retry: {
      resultKind: `same`,
      notApplicable: true,
    },
    enterReplayMode: {
      resultKind: `replaying`,
      note: `canEnterReplayMode() → true`,
    },
  },

  replaying: {
    response: {
      resultKind: `syncing`,
      action: `accepted`,
    },
    messages: {
      resultKind: `same`,
      sameReference: true,
      note: `no upToDate message, stays replaying`,
    },
    messagesUtd: {
      resultKind: `live`,
      note: `hasUpToDateMessage → transitions to LiveState`,
    },
    sseClose: {
      resultKind: `same`,
      sameReference: true,
    },
    pause: {
      resultKind: `paused`,
    },
    resume: {
      resultKind: `same`,
      notApplicable: true,
    },
    error: {
      resultKind: `error`,
    },
    retry: {
      resultKind: `same`,
      notApplicable: true,
    },
    enterReplayMode: {
      resultKind: `same`,
      notApplicable: true,
      note: `canEnterReplayMode() → false`,
    },
  },

  paused: {
    response: {
      resultKind: `paused`,
      action: `accepted`,
      note: `delegates to inner state, wraps result in paused`,
    },
    messages: {
      resultKind: `same`,
      sameReference: true,
      note: `ignored — paused state does not process messages`,
    },
    messagesUtd: {
      resultKind: `same`,
      sameReference: true,
      note: `ignored — paused state does not process messages`,
    },
    sseClose: {
      resultKind: `same`,
      sameReference: true,
      note: `ignored`,
    },
    pause: {
      resultKind: `same`,
      sameReference: true,
      note: `idempotent — pause on paused returns this`,
    },
    resume: {
      resultKind: `syncing`,
      note: `returns previousState (kind depends on what was paused)`,
    },
    error: {
      resultKind: `error`,
      note: `ErrorState can wrap PausedState`,
    },
    retry: {
      resultKind: `same`,
      notApplicable: true,
    },
    enterReplayMode: {
      resultKind: `same`,
      notApplicable: true,
    },
  },

  error: {
    response: {
      resultKind: `same`,
      sameReference: true,
      action: `ignored`,
      note: `error state ignores response`,
    },
    messages: {
      resultKind: `same`,
      sameReference: true,
      note: `error state ignores messages`,
    },
    messagesUtd: {
      resultKind: `same`,
      sameReference: true,
      note: `error state ignores messages`,
    },
    sseClose: {
      resultKind: `same`,
      sameReference: true,
      note: `error state ignores sseClose`,
    },
    pause: {
      resultKind: `paused`,
      note: `PausedState wrapping ErrorState`,
    },
    resume: {
      resultKind: `same`,
      notApplicable: true,
    },
    error: {
      resultKind: `error`,
      note: `can create new error wrapping the same previous state`,
    },
    retry: {
      resultKind: `syncing`,
      note: `returns previousState (kind depends on what errored)`,
    },
    enterReplayMode: {
      resultKind: `same`,
      notApplicable: true,
    },
  },
}

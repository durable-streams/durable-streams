# Durable Streams client state machine specification

This document is the single source of truth for the 7-state stream response
state machine implemented in `src/stream-response-state.ts`.

## States

| Kind          | Class             | Group    | Description                             |
| ------------- | ----------------- | -------- | --------------------------------------- |
| `initial`     | `InitialState`    | Fetching | Before first server response            |
| `syncing`     | `SyncingState`    | Fetching | Response received, waiting for upToDate |
| `stale-retry` | `StaleRetryState` | Fetching | Re-fetching with cache buster           |
| `live`        | `LiveState`       | Active   | Up-to-date, streaming live updates      |
| `replaying`   | `ReplayingState`  | Active   | Replaying cached messages               |
| `paused`      | `PausedState`     | Delegate | PauseLock held, wraps previous state    |
| `error`       | `ErrorState`      | Delegate | Error occurred, wraps previous state    |

### Hierarchy

```
StreamState (abstract)
├── ActiveState (abstract) — offset, cursor, upToDate, streamClosed
│   ├── FetchingState (abstract) — shouldUseSse() → false
│   │   ├── InitialState
│   │   ├── SyncingState
│   │   └── StaleRetryState   — cacheBuster: string
│   ├── LiveState              — consecutiveShortConnections, sseFallbackToLongPolling
│   └── ReplayingState         — replayCursor: string
├── PausedState             — previousState: ActiveState | ErrorState
└── ErrorState              — previousState: ActiveState | PausedState, error: Error
```

## Events

| Event             | Method / action                       | Input type              |
| ----------------- | ------------------------------------- | ----------------------- |
| `response`        | `handleResponseMetadata(input)`       | `ResponseMetadataInput` |
| `messages`        | `handleMessageBatch(input)`           | `MessageBatchInput`     |
| `sseClose`        | `handleSseConnectionClosed(input)`    | `SseCloseInput`         |
| `pause`           | `pause()`                             | —                       |
| `resume`          | `resume()`                            | —                       |
| `error`           | `toErrorState(error)`                 | `Error`                 |
| `retry`           | `retry()`                             | —                       |
| `enterReplayMode` | construct `ReplayingState` externally | `replayCursor: string`  |

## Transition table

Rows = current state, columns = event. Cell format: `→ resultKind (notes)`.
`self` means returns `this` (same reference). `ignored` means no state change.

| State       | response       | messages         | sseClose     | pause    | resume | error   | retry  | enterReplay   |
| ----------- | -------------- | ---------------- | ------------ | -------- | ------ | ------- | ------ | ------------- |
| initial     | → syncing      | → self           | → self       | → paused | N/A    | → error | N/A    | → replaying   |
| syncing     | → syncing      | → live (if utd)  | → self       | → paused | N/A    | → error | N/A    | → replaying   |
| stale-retry | → syncing      | → self           | → self       | → paused | N/A    | → error | N/A    | N/A (blocked) |
| live        | → live         | → live           | → live (SSE) | → paused | N/A    | → error | N/A    | → replaying   |
| replaying   | → syncing      | → live (if utd)  | → self       | → paused | N/A    | → error | N/A    | N/A (blocked) |
| paused      | → paused (fwd) | → self (ignored) | → self (ign) | → self   | → prev | → error | N/A    | N/A           |
| error       | → self (ign)   | → self (ignored) | → self (ign) | → paused | N/A    | → error | → prev | N/A           |

Notes:

- `syncing + messages(utd)` → `live`: only when `hasUpToDateMessage` is true
- `live + response` → `live`: preserves SSE tracking fields
- `live + sseClose` → `live`: updates short-connection tracking
- `paused + response` → delegates to inner, wraps result in paused
- `error + response/messages/sseClose` → ignored (returns self)
- `enterReplayMode` is blocked for `stale-retry` and `replaying` (canEnterReplayMode → false)

## Invariants

### I0: Kind/instanceof consistency

The `kind` field always matches the runtime class:

- `initial` ↔ `InitialState`
- `syncing` ↔ `SyncingState`
- `stale-retry` ↔ `StaleRetryState`
- `live` ↔ `LiveState`
- `replaying` ↔ `ReplayingState`
- `paused` ↔ `PausedState`
- `error` ↔ `ErrorState`

### I1: upToDate iff LiveState in delegation chain

`state.upToDate === true` implies that somewhere in the delegation chain
(through paused/error wrappers), the leaf active state is `LiveState`.
Exception: `streamClosed` may set `upToDate` in non-live states.

### I2: Immutability

All transitions create new state objects. No-op transitions (`pause()` on
`PausedState`, ignored events on `ErrorState`) return `this`.

### I3: Pause/resume round-trip preserves identity

For any `ActiveState` or `ErrorState` s:

```
s.pause().resume() === s
```

### I4: Error/retry preserves identity

For any `ActiveState` s and error e:

```
s.toErrorState(e).retry() === s
```

### I5: LiveState SSE tracking

`LiveState` tracks `consecutiveShortConnections` and `sseFallbackToLongPolling`.
When `sseFallbackToLongPolling` is true, `shouldUseSse()` returns false
regardless of options.

### I6: StaleRetryState has cacheBuster

Every `StaleRetryState` instance has a non-empty `cacheBuster` string.
`canEnterReplayMode()` returns false.

### I7: ReplayingState has replayCursor

Every `ReplayingState` instance has a non-empty `replayCursor` string.
`canEnterReplayMode()` returns false.

### I8: PausedState delegation

`PausedState` delegates `offset`, `cursor`, `upToDate`, `streamClosed`,
and `shouldUseSse()` to its `previousState`. `pause()` is idempotent
(returns `this`).

### I9: ErrorState delegation

`ErrorState` delegates `offset`, `cursor`, `upToDate`, `streamClosed`,
and `shouldUseSse()` to its `previousState`. Has a non-null `error` property.

### I12: No same-type nesting

- `PausedState` never wraps another `PausedState` (constructor flattens)
- `ErrorState` never wraps another `ErrorState` (constructor flattens)

## Constraints

### C1: StaleRetryState cannot enter replay mode

`StaleRetryState.canEnterReplayMode()` returns `false`. This prevents entering
replay mode while a cache-busted re-fetch is in progress.

### C3: Error ignores response/messages/sseClose; Paused ignores messages/sseClose

`ErrorState.handleResponseMetadata()` returns `{ action: "ignored", state: this }`.
`ErrorState.handleMessageBatch()` returns `{ state: this, suppressBatch: false, becameUpToDate: false }`.
`ErrorState.handleSseConnectionClosed()` returns `{ state: this }`.

`PausedState.handleMessageBatch()` returns `{ state: this, suppressBatch: false, becameUpToDate: false }`.
`PausedState.handleSseConnectionClosed()` returns `{ state: this }`.
`PausedState.handleResponseMetadata()` delegates to inner and wraps result.

### C8: SSE state is private to LiveState

Only `LiveState` tracks `consecutiveShortConnections` and `sseFallbackToLongPolling`.
Only `LiveState.handleSseConnectionClosed()` performs non-trivial logic. All other
states return `{ state: this }` for `sseClose`.

## Bidirectional enforcement checklist

Every invariant and constraint above is enforced in at least two ways:

| ID  | Static (types)                    | Dynamic (tests)                             |
| --- | --------------------------------- | ------------------------------------------- |
| I0  | `kind` literal types              | Tier 2 truth table, Tier 1 scenarios        |
| I1  | —                                 | `assertStateInvariants` on every transition |
| I2  | readonly fields                   | Reference equality checks in Tier 2         |
| I3  | —                                 | Tier 3 algebraic property tests             |
| I4  | —                                 | Tier 3 algebraic property tests             |
| I5  | Private fields on LiveState       | Tier 5 SSE fallback tests                   |
| I6  | Constructor requires cacheBuster  | `assertStateInvariants` checks              |
| I7  | Constructor requires replayCursor | `assertStateInvariants` checks              |
| I8  | —                                 | Tier 2 + Tier 3                             |
| I9  | —                                 | Tier 2 + Tier 3                             |
| I12 | —                                 | `assertStateInvariants` checks              |
| C1  | —                                 | Tier 2 truth table                          |
| C3  | —                                 | Tier 2 truth table                          |
| C8  | Private fields                    | Tier 5 dedicated tests                      |

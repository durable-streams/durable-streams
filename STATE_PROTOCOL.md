# Durable Streams State Protocol v0.1

**Status:** Draft
**Package:** `@durable-streams/state`
**Audience:** Protocol implementors and library authors

---

## 1. Purpose and Scope

The Durable Streams State Protocol defines a standard envelope and semantics for **mutable state change events** (insert / update / delete) carried over an ordered stream.

The protocol is:

- **Transport-agnostic** – works over any stream that provides ordered, replayable events.
- **Storage-agnostic** – materialized state can live purely in memory or be persisted to any backing store.
- **Schema-aware** – integrates with [Standard Schema](https://standardschema.dev/) so events can be validated and typed end‑to‑end.

The spec defines:

- The **event model** (`ChangeEvent` and `ControlEvent`)
- The **state semantics** for applying events
- The **materialization contract** (`MaterializedState`)
- The **schema contract** (`defineStreamState`)

It does **not** define:

- Conflict resolution strategies (CRDTs, last‑write‑wins, etc.)
- How streams are created, named, or versioned
- How redirects/aliases across stream versions are implemented

Those are left to higher‑level, domain‑specific protocols.

---

## 2. Assumptions and Requirements

The State Protocol assumes an underlying **ordered event stream** with the following properties:

1. **Total order per stream**
   Every event on a given stream has a well‑defined position; all consumers observe events in the same order.

2. **Replayability**
   Consumers can read from an initial position (e.g. "beginning" or a specific offset) and receive all subsequent events in order.

3. **Exactly‑once delivery for monotonic consumers**
   For a consumer that always resumes from the last provided position, each event for that consumer is processed exactly once.

4. **Content type**
   For JSON bindings, the stream stores a sequence of JSON values. Each value is a single **State Event** (see §4).

Durable Streams in `application/json` mode is one such transport; other transports may be used if they satisfy the same properties.

The State Protocol itself is **content-level**: it only constrains the shape and meaning of the JSON messages, not how they are moved over the wire.

---

## 3. Terminology

- **Stream** – An ordered sequence of events produced and consumed via some transport (e.g. Durable Streams).
- **Entity Type** – A logical kind of object, identified by a string (`"user"`, `"message"`, `"cart"`, …).
- **Key** – A unique identifier for an entity within a type (`"user:123"`, `"msg:456"`, …).
- **Value** – The current JSON representation of an entity.
- **State** – A mapping `(type, key) → value` (or "no value", if deleted).
- **State Event** – A JSON object conforming to either `ChangeEvent` or `ControlEvent`.
- **Materialization** – The process of applying a sequence of State Events to reconstruct state.

---

## 4. Event Model

Every JSON item on a state stream MUST be a **State Event**:

```ts
type StateEvent = ChangeEvent | ControlEvent
```

Implementations SHOULD use a discriminated union in their type system.

### 4.1 Change Events

A **Change Event** represents an insert, update, or delete of a single entity `(type, key)`.

Canonical envelope:

```ts
interface ChangeEvent<T = unknown> {
  // Domain identity
  type: string // Entity type discriminator (e.g. "user", "message")
  key: string // Entity identifier (unique within type)

  // Value
  value?: T // Canonical new value for this (type, key)
  old_value?: T // Optional previous value (advisory only)

  headers: {
    operation: "insert" | "update" | "delete"
    timestamp?: string // Advisory timestamp (e.g. ISO 8601)
    txid?: string // Optional transaction / correlation ID
  }
}
```

> **Note:** TypeScript type signatures in this spec are informative. Normative behavior is defined in prose.

Normative rules:

1. **Operation semantics**

   For a given `(type, key)`:
   - `operation = "insert"` – The new state for `(type, key)` becomes `value`.
   - `operation = "update"` – The new state for `(type, key)` becomes `value`.
   - `operation = "delete"` – The state for `(type, key)` becomes "no value" (removed).

   For materialization purposes, **both `insert` and `update` are treated as "set to `value`"**. The distinction is available for higher‑level semantics (e.g. validation, conflict resolution) but MUST NOT be required for correctness of the core state algorithm.

2. **Presence of `value`**
   - For `operation = "delete"`, `value` MAY be omitted or set to any value. Materializers MUST ignore `value` for delete operations.
   - For `operation = "insert"` or `"update"`, `value` SHOULD be present and SHOULD conform to the configured schema for this `type`.
   - Materializers encountering a missing or invalid `value` for insert/update MAY treat it as an error or no-op according to implementation policy.

3. **`old_value`**
   - `old_value` is **advisory metadata** (for debugging, auditing, or external consumers).
   - Materializers MUST NOT depend on `old_value` being present or correct.
   - Producers SHOULD NOT rely on `old_value` for correctness.

4. **Ordering**
   - Change Events MUST be applied to materialized state in the order they appear on the stream.
   - For a given `(type, key)`, later events MUST override earlier ones.

5. **Idempotence**
   - Under the transport assumptions (§2), a consumer that resumes from the last provided position processes each Change Event exactly once.
   - If a deployment uses a weaker transport (e.g. at‑least‑once), it MUST perform deduplication at the transport layer before passing events into the State Protocol.

6. **Timestamps and `txid`**
   - `timestamp` is advisory metadata (e.g. for UI and logging). It MUST NOT be used to derive ordering; ordering is defined solely by stream position.
   - `txid` is an opaque correlation identifier that MAY be used by higher‑level logic (e.g. grouping multiple changes into a transaction, mapping optimistic mutations to server commits). The base protocol assigns no semantics.

---

### 4.2 Control Events

A **Control Event** represents stream‑level or snapshot‑level metadata that affects how consumers manage materialized state but does not directly change entity values.

Canonical envelope:

```ts
interface ControlEvent {
  headers: {
    control: "up-to-date" | "snapshot-start" | "snapshot-end" | "reset"
    offset?: string // Optional stream offset/position marker
  }
}
```

Discriminant:

- An event with **`headers.control` property** MUST be treated as a `ControlEvent`.
- Events with **`headers.operation` property** MUST be treated as `ChangeEvent`s.
- Type guards:

  ```ts
  function isChangeEvent(event: StateEvent): event is ChangeEvent {
    return "operation" in event.headers
  }

  function isControlEvent(event: StateEvent): event is ControlEvent {
    return "control" in event.headers
  }
  ```

Normative semantics (v0.1):

1. **`snapshot-start`**
   - Indicates that subsequent Change Events up to a matching `snapshot-end` form a **logically consistent snapshot** of the state.
   - Consumers MAY use this as a hint for taking durable checkpoints, but are not required to.
   - There MAY be multiple snapshot ranges over the lifetime of a stream.

2. **`snapshot-end`**
   - Closes the snapshot started by the preceding `snapshot-start`.
   - There MUST NOT be nested snapshots in v0.1; a new `snapshot-start` SHOULD NOT appear before the previous `snapshot-end`.
   - Consumers receiving `snapshot-end` without a matching `snapshot-start` SHOULD log a warning but continue processing.

3. **`up-to-date`**
   - Indicates that the producer has sent all currently known events up to the current tail of the stream.
   - Primarily useful for live tailing and reactive UIs ("safe to render now").
   - A consumer MAY treat receipt of `up-to-date` as a point where all prior Change Events in the stream have been fully applied.

4. **`reset`**
   - Signals that previously materialized state for this stream is no longer valid.
   - This spec does not mandate how `reset` is handled. Common strategies:
     - Clear all materialized state and continue processing subsequent events
     - Disconnect and reconnect to a new stream version
     - Surface an error to the application layer
   - When `reset` appears, it applies to all events **before** the reset event. Events **after** the reset represent a new epoch.

5. **`offset`**
   - An optional field providing the stream position/offset where this control event was generated.
   - Primarily informative; consumers MAY use it for logging or debugging.

Control Events MUST NOT directly modify the state mapping. Their only effect is via the rules above and any higher-level handling.

---

## 5. State Semantics

### 5.1 Conceptual State

For a given stream, define its **materialized state** as a partial function:

```text
State: (type: string, key: string) → value | ⊥
```

where `⊥` denotes "no value / deleted".

Starting from `State₀` (typically the empty mapping), applying a sequence of State Events `{e₁, e₂, …, eₙ}` in order yields `Stateₙ`.

### 5.2 Application Rules (Change Events)

Given a Change Event `c` with:

- `t = c.type`
- `k = c.key`
- `op = c.headers.operation`
- `v = c.value`

and current state `State`, the next state `State'` is defined as:

- If `op` is `"insert"` or `"update"`:

  ```text
  State'(t, k) = v
  State'(t', k') = State(t', k')  for all (t', k') ≠ (t, k)
  ```

- If `op` is `"delete"`:

  ```text
  State'(t, k) = ⊥
  State'(t', k') = State(t', k')  for all (t', k') ≠ (t, k)
  ```

Note:

- The protocol does **not** distinguish `insert` and `update` at the level of pure state. They are both "set `value` for `(type,key)`".
- Implementations MAY log or surface discrepancies, e.g. `update` on a missing key or `insert` on an existing key, but MUST NOT rely on such errors to maintain correct state.

### 5.3 Application Rules (Control Events)

Given a Control Event:

- `snapshot-start`, `snapshot-end`, `up-to-date`
  – Have **no direct effect** on `State`. They only provide hints for checkpointing and liveness.

- `reset`
  – The handling of `reset` is **implementation-defined**. The spec does not mandate whether materializers clear state, disconnect, or take other action. Higher-level protocols or applications define reset semantics.

---

## 6. MaterializedState API

The `MaterializedState` class in `@durable-streams/state` is the reference implementation of the materialization rules above.

A minimal conforming implementation MUST provide at least the following behaviour:

```ts
class MaterializedState {
  apply(event: ChangeEvent): void
  applyBatch(events: ChangeEvent[]): void

  get(type: string, key: string): unknown | undefined
  getType(type: string): Map<string, unknown>
}
```

Normative requirements:

1. **`apply(event)`**
   - MUST accept a `ChangeEvent` and update the internal state according to §5.2.
   - The reference implementation does **not** handle `ControlEvent` directly. Control events are expected to be processed by higher-level stream consumers before passing change events to `MaterializedState`.

2. **`applyBatch(events)`**
   - MUST be equivalent to calling `apply` sequentially on each `event` in the order given.

3. **`get(type, key)`**
   - MUST return the current value for `(type, key)` if present, otherwise `undefined`.

4. **`getType(type)`**
   - MUST return a view of all `(key, value)` pairs with the given `type`.
   - The reference implementation returns a `Map<string, unknown>`.

Implementations MAY add additional methods (e.g. `clear()`, `types`, `typeCount`) so long as they respect the semantics above.

**Control Event Handling:**

- The `MaterializedState` class focuses exclusively on materializing change events.
- Control events like `reset`, `up-to-date`, etc. are expected to be handled by the stream consumption layer (e.g. in the application's event loop or a higher-level wrapper).
- Applications that need to handle `reset` would typically:
  1. Detect the `reset` control event while reading the stream
  2. Call `materializedState.clear()` (or create a new instance)
  3. Continue processing subsequent change events

---

## 7. Schema Definition and Validation

State Protocol streams are **schema‑aware but schema‑agnostic**: they know that values have schemas, but do not mandate a specific schema library.

In `@durable-streams/state`, schemas are configured via **Standard Schema**:

```ts
const streamState = defineStreamState({
  collections: {
    users: { schema: userSchema, type: "user" },
    messages: { schema: messageSchema, type: "message" },
    // ...
  },
})
```

Normative rules:

1. **Type-to-schema mapping**
   - Each logical collection is configured with:
     - A `type` string (used in Change Events), and
     - A Standard Schema for its `value` shape.
   - For a given `type` string, there MUST be at most one configured schema in a given `defineStreamState` instance.

2. **Producer responsibilities**
   - Producers SHOULD ensure that `value` conforms to the configured schema for its `type` before appending a Change Event.
   - Producers MAY still send events that violate the schema; behaviour in this case is implementation‑defined.

3. **Consumer responsibilities**
   - Consumers MAY validate `value` against the schema before applying events.
   - On validation failure, consumers MAY:
     - Drop the event,
     - Stop the stream and surface an error,
     - Materialize a partial/fallback value,
     - Or take other appropriate action.
   - This spec does not mandate a single behaviour, but consumers MUST avoid corrupting their internal state (e.g. must not treat invalid data as valid without some form of mitigation).

4. **Schema evolution**
   - v0.1 does not define cross‑version compatibility semantics.
   - Deployments that evolve schemas in incompatible ways SHOULD:
     - Treat such changes as a new logical "epoch" of the stream, and
     - Use a `reset` Control Event and/or higher‑level stream indirection (e.g. proxies that map stable URLs to versioned underlying streams) to ensure clients resync from a clean state.

---

## 8. Transport Binding: Durable Streams JSON Mode (Informative)

This section describes one common binding of the State Protocol to a concrete transport: **Durable Streams in `application/json` mode**. It is informative but reflects typical usage in `@durable-streams/state`.

- Streams are created with `Content-Type: application/json`.
- Each `append()` call writes a single JSON value that MUST be a `StateEvent` (Change or Control).
- Reads return arrays of JSON values in order.
- The Durable Streams client library exposes these as `unknown[]` which are then typed as `StateEvent[]` by `@durable-streams/state`.

Example:

```ts
// Create a durable JSON stream
const stream = await DurableStream.create({
  url: "https://example.com/v1/stream/chat-room-123",
  contentType: "application/json",
})

// Append a Change Event
await stream.append({
  type: "message",
  key: "msg:456",
  value: { userId: "user:123", text: "Hello!" },
  headers: { operation: "insert" },
})

// Consume and materialize
const state = new MaterializedState()

for await (const events of stream.jsonStream(/* ... */)) {
  for (const event of events) {
    if (isChangeEvent(event)) {
      state.apply(event)
    } else if (isControlEvent(event)) {
      // Handle control events at application level
      if (event.headers.control === "reset") {
        state.clear()
      }
      // Other control events can be logged or used for UI updates
    }
  }
}
```

Other transports may adopt the same event shapes and semantics, provided they preserve order and exactly‑once delivery for monotonic consumers.

---

## 9. Non‑Goals and Future Extensions

This v0.1 spec deliberately does **not** cover:

- **Conflict resolution semantics**
  – e.g. how to merge concurrent writes from multiple writers. Different deployments may use:
  - Last‑write‑wins based on timestamps,
  - CRDTs encoded in `value` or external patch fields,
  - Server‑authoritative application logic.
    The base protocol is neutral; it only ensures that all participants see the same ordered sequence of changes.

- **Multi-entity transactions**
  – `txid` exists as a correlation mechanism, but this spec does not define transactional guarantees across multiple Change Events.

- **Patch semantics**
  – Future versions may add an optional `patch` field to `ChangeEvent` for incremental updates (e.g. JSON Patch, CRDT ops). v0.1 relies exclusively on full `value` replacement.

- **Stream versioning and redirects**
  – `reset` gives a clean "drop state" signal; discovery of a new stream or version is intentionally left to domain‑specific wrappers (e.g. proxies that map a stable URL to a versioned underlying stream).

---

## Appendix A: Implementation Checklist

For implementors building State Protocol-compliant systems:

**Producer checklist:**

- [ ] Events are appended in a well-defined order
- [ ] Each ChangeEvent includes `type`, `key`, `value`, and `headers.operation`
- [ ] Delete operations may omit `value` or set it to null
- [ ] Control events use `headers.control` with valid control kinds
- [ ] Timestamps (if present) are advisory only

**Consumer checklist:**

- [ ] Events are processed in stream order
- [ ] Type guards correctly distinguish ChangeEvent vs ControlEvent
- [ ] Materializer applies insert/update/delete correctly per §5.2
- [ ] old_value is not used for correctness
- [ ] Control events are handled appropriately (log, clear state, etc.)
- [ ] Schema validation (if enabled) does not corrupt state on failure

**Transport checklist:**

- [ ] Provides total order per stream
- [ ] Supports replayability from arbitrary offsets
- [ ] Delivers events exactly-once for monotonic consumers
- [ ] Preserves JSON structure for StateEvent objects

---

_End of Durable Streams State Protocol v0.1_

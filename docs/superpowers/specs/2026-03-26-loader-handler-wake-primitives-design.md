# Loader/Handler Architecture + Wake Primitives Implementation

## Summary

Replace the current `setup() + agent factory + implicit agent loop + client-side effects` model with an explicit `loader(ctx, wake) → handler(ctx, wake, loaded) → ctx.agent()` model, backed by server-side wake primitives that replace client-side effects.

One pass. Clean break — no backward compatibility. TS dev server only (conformance tests for caddy portability).

## Prior Design Documents

- `docs/runtime-revision.md` — Loader/handler architecture spec (this spec supersedes it where they diverge, notably the loader→handler data flow via return value)
- `docs/dialectics/effects-vs-triggers/chatgpt-prompt.md` — Wake primitives design with research

---

## Section 1: Wake Type System & Server-Side Registry

### Types

```typescript
type Wake =
  | "runFinished" // sugar: watch runs collection for terminal status
  | {
      on: "change"
      collections?: string[] // which collections to watch (default: all)
      debounceMs?: number // coalesce rapid mutations into single wake
      timeoutMs?: number // inject timeout wake if no match within window
    }

type WakeMessage = {
  type: "wake"
  source: string // entity URL or shared state ID
  timeout: boolean // true if timeout, no matching change
  changes: Array<{
    collection: string
    kind: "insert" | "update" | "delete"
    key: string
  }>
}
```

### Wake on spawn/observe/connectSharedState

The `Wake` type is accepted as an option on `spawn`, `observe`, and `connectSharedState` (`createSharedState` is for one-time resource creation and does not accept wake):

```typescript
ctx.spawn("worker", "analyst", config, {
  initialMessage: "analyze this",
  wake: "runFinished",
})

ctx.observe("/some/entity", {
  wake: { on: "change", collections: ["texts", "toolCalls"] },
})

ctx.connectSharedState("debate-state", debateSchema, {
  wake: { on: "change", collections: ["arguments"], debounceMs: 1000 },
})
```

### Server-side wake registry

An in-memory lookup cache of `sourceUrl → WakeRegistration[]`, rebuilt on server startup by scanning persisted entity manifests / materialized state. The entity manifest (persisted in the entity's stream) is the durable source of truth for all relationships and wake declarations. The in-memory map is a derived cache for O(1) lookup on the hot path.

**Ephemeral timers (v1):** `debounceMs` and `timeoutMs` timers are in-memory and are lost on server restart. This is acceptable for the dev server; a production implementation would need to persist timer state or re-derive deadlines from manifests on startup.

```typescript
type WakeRegistration = {
  subscriberUrl: string
  sourceUrl: string
  condition: { on: "change"; collections?: string[] } // desugared from shorthand
  debounceMs?: number
  timeoutMs?: number
}
```

**"runFinished" desugaring**: Server-side, `"runFinished"` is special-cased — it does not desugar to a generic `{ on: "change" }` condition. The server checks specifically for a run event with terminal status (completed or failed) in the entity event schema. This is a hardcoded check, not expressible in the generic condition type.

### WakeEvent

The wake event passed to loader/handler wraps the wake reason in a standard envelope:

```typescript
type WakeEvent = {
  source: string // stream or entity URL that fired this
  type: string // "wake" | "message" | "timeout" | "cron" | ...

  fromOffset: number // entity's last-read offset for this source
  toOffset: number // current head of the source stream
  eventCount: number // how many new events

  payload?: any // small payloads inlined (e.g. WakeMessage for wake-type events)
  summary?: string // large payloads summarized
  fullRef?: string // ref for loadReference() tool
}
```

`WakeEvent` is the universal envelope for all wake reasons, as defined in `runtime-revision.md`. `WakeMessage` is the durable payload carried inside `wake.payload` when `wake.type === "wake"`. For direct messages (`ctx.send()`), `wake.type` is `"message"` with the message as payload. For the initial spawn, `wake.type` is `"message"` with the `initialMessage`.

### Registration lifecycle

- Registrations are created atomically as part of server-side spawn/observe/connectSharedState operations. For `spawn(..., { wake })`, the server registers the wake _before_ creating the child entity and delivering its initial message — this prevents races where a fast child completes before the wake exists. The same atomic ordering applies to `observe` and `connectSharedState`: the wake registration is persisted before any subscription or connection is established.
- `"runFinished"` is one-shot: fires once, auto-removed
- Collection watches persist until the subscribing entity is deleted (no explicit removal verb in v1)
- Entity deletion removes all registrations where entity is subscriber OR source

---

## Section 2: EntityDefinition & Runtime Context

### EntityDefinition

```typescript
type EntityDefinition<TState, TLoaded> = {
  description?: string
  state?: Record<string, CollectionDefinition>
  creationSchema?: StandardJSONSchemaV1
  inboxSchemas?: Record<string, StandardJSONSchemaV1>
  outputSchemas?: Record<string, StandardJSONSchemaV1>

  loader?: (ctx: LoaderContext, wake: WakeEvent) => TLoaded | Promise<TLoaded>
  handler: (
    ctx: HandlerContext,
    wake: WakeEvent,
    loaded: TLoaded
  ) => void | Promise<void>
}
```

**Removed**: `setup`, `agent`, `effects`, `context`, `actions`.

**Kept**: `description`, `state`, `creationSchema`, `inboxSchemas`, `outputSchemas`.

### Loader → handler data flow

Follows the TanStack Router / React Router pattern: loader returns data, handler receives it as a typed parameter. TypeScript infers the connection because both functions are co-located on the same object literal passed to `defineEntity()`.

```typescript
defineEntity("my-agent", {
  async loader(ctx, wake) {
    const self = await ctx.observe(ctx.entityUrl)
    ctx.addContext(toMessages(self.db))
    return self.state
  },

  async handler(ctx, wake, state) {
    // state is typed from loader's return
    state.status.get("current")

    await ctx.agent(
      createPiAgentAdapter({
        context: ctx.context,
        tools: [...ctx.darixTools, ...myTools],
      })
    )
  },
})
```

If no loader is defined, handler receives `undefined` as the third parameter.

### LoaderContext (data I/O only)

- `firstWake: boolean`
- `entityUrl: string`
- `observe(url, opts?): Promise<EntityHandle>`
- `addContext(...): void`
- `createSharedState(id, schema): SharedStateHandle`
- `connectSharedState(id, schema, opts?): SharedStateHandle`

Nothing is loaded upfront. The loader decides what to load and what to pass to the handler.

`firstWake` is `true` when the entity's stream is empty (no prior events). Derived from the materialized StreamDB offset being 0 / stream having no events at epoch claim time.

### HandlerContext (extends loader with action verbs)

- Everything from LoaderContext
- `context: Message[]` (accumulated by loader via `addContext`)
- `darixTools: AgentTool[]` (built-in tools: loadReference, etc.)
- `agent(adapter): Promise<AgentRunResult>` (returns `{ result, writes, toolCalls, usage }`)
- `spawn(type, id, config, opts): Promise<EntityHandle>`
- `send(entityUrl, payload): Promise<void>`
- `sleep(): void`

### No pre-loaded state

State collections (via `ctx.db.collections` for reads, `ctx.db.actions` for writes) are not pre-materialized. They become available after the loader observes the entity's own stream. The loader returns whatever the handler needs — state, handles, computed data. If the loader doesn't observe the entity's stream, the handler doesn't get state.

---

## Section 3: Wake Processing Pipeline

### Current flow (being replaced)

```
webhook → preload → claim epoch → setup()
  → build context (auto) → create agent → SSE tail
  → processMessage loop → idle timer → sleep
```

### New flow

```
webhook arrives (body includes WakeEvent)
  │
  ├─ claim epoch + materialize StreamDB (parallel, as today)
  │    └─ full stream loaded (no partial loading until checkpointing exists)
  │
  ├─ loader(ctx, wake)
  │    ├─ wake event comes from webhook body (also persisted in entity's stream)
  │    ├─ ctx.observe(ctx.entityUrl) → handle to already-materialized StreamDB
  │    ├─ ctx.addContext() builds context from stream data
  │    └─ returns data for handler
  │
  ├─ handler(ctx, wake, loaded)
  │    ├─ ctx.agent() zero or N times
  │    └─ spawn, send, state mutations
  │
  └─ after handler returns:
       ├─ sleep (ctx.sleep() called) OR idle (existing idleTimeout config on ProcessWakeConfig)
       └─ new message on main → fresh loader+handler cycle
```

### Key changes from current flow

1. **No implicit agent loop.** The current runtime opens an SSE connection and runs a processMessage loop. New model: handler runs once per wake, calls `ctx.agent()` explicitly, returns.

2. **StreamDB materialization stays.** The entity's main stream is still fully materialized before loader runs (same as today's `db.preload()`). Partial loading requires checkpointing support — future work.

3. **`ctx.observe(ctx.entityUrl)` returns already-materialized data.** It doesn't re-fetch. The loader uses it to access the StreamDB and decide what goes into context.

4. **Wake is durable.** The server builds a `WakeEvent` envelope and puts it in both places: appended to the subscriber's entity stream (durable history) and included in the webhook body (immediate delivery). Past WakeEvents appear in conversation history on subsequent wakes.

5. **Post-handler lifecycle unchanged.** After handler returns: sleep immediately (if `ctx.sleep()`) or idle per existing `idleTimeout` config. New message on main starts a fresh loader+handler cycle.

---

## Section 4: Server-Side Wake Evaluation

### Evaluation hot path (in darix-manager.ts)

```
event appended to child's stream
  → server durably acknowledges the write
  → hash lookup: any wake registrations watching this source URL?
  → if "runFinished": is this a run status change to completed/failed?
  → if { on: "change", collections }: does event belong to a watched collection?
  → if match:
      1. build WakeEvent (type: "wake", payload: WakeMessage, source offsets, etc.)
      2. append WakeEvent to subscriber's stream (durable history)
      3. deliver WakeEvent in webhook body to subscriber
```

Wake evaluation happens AFTER the write is durably acknowledged — not on optimistic append.

### Debounce

If `debounceMs` is set, the server buffers matching events and delivers one coalesced WakeMessage after the window closes. One timer per registration.

### Timeout

If `timeoutMs` is set, the server starts a timer at registration time. If no matching event fires before expiry, it delivers a WakeMessage with `timeout: true, changes: []`.

### WakeEvent delivery

The server builds a `WakeEvent` envelope (with `type: "wake"`, source offsets, and the `WakeMessage` as `payload`). This WakeEvent is put in both places:

1. Appended to the subscriber's entity stream (durable history)
2. Included in the webhook body to the subscriber (immediate wake delivery)

The same `WakeEvent` shape is used for all wake reasons — wake, message, timeout, etc. The subscriber's loader/handler always receives a `WakeEvent`, never a raw `WakeMessage`.

---

## Section 5: Testing Strategy

### New conformance tests (server-conformance-tests)

These test the server's wake evaluation contract, independent of the runtime. Portable to caddy.

1. **Wake on runFinished**: spawn child with wake → child completes → parent's stream gets WakeMessage → parent wakes via webhook
2. **Wake on collection change**: observe with collection wake → source gets new events → subscriber wakes
3. **Wake after durable ack**: verify wake evaluation happens post-acknowledgment
4. **Timeout**: register with timeoutMs → no match → timeout WakeMessage delivered
5. **Debounce**: register with debounceMs → rapid events → single coalesced WakeMessage
6. **Cleanup on delete**: delete subscriber → registrations removed → source events no longer cause wakes
7. **WakeEvent in stream and webhook body**: assert same WakeEvent (with WakeMessage payload) appears in both the subscriber's stream and the webhook body
8. **Wake registry rebuild on restart**: register wake → restart server → source event fires → subscriber still wakes. Verifies the registry is correctly rebuilt from persisted manifests on startup.
9. **Spawn+wake ordering (no missed completion)**: spawn child with `wake: "runFinished"` where the child completes near-instantly → assert parent receives the wake. Verifies the server registers the wake before starting the child.

### Playground conversion

The playground examples (`examples/durable-agents-playground/src/`) and their tests must be converted to the new loader/handler + wake shape. Draft conversions already exist in `src-revised/` — these become the canonical source, replacing the current `src/` directory.

### DSL test conversion

The tests use fake agent adapters (not real LLMs), so conversion is mechanical:

- `setup()` → `loader()` with `ctx.firstWake` guard
- `agent` factory → `handler()` with `ctx.agent()` call
- `effects` → removed, replaced by `wake` on spawn/observe
- Snapshots regenerated (event shapes change with WakeMessages)

Test DSL updates (`runtime-dsl.ts`):

- `t.define()` accepts new EntityDefinition shape
- `t.spawn()` passes `wake` options through to server
- New helper: `waitForWake()` to assert wake delivery

Breakdown:

- **~50 tests** (groups A-E, basic lifecycle) — mechanical conversion, new definition shape, same assertions
- **~12 tests** (groups F-L, coordination) — need wake primitives working end-to-end
- **~10 tests** (effects) — deleted or rewritten as wake tests

---

## What Gets Deleted

- `setup()` hook on EntityDefinition
- `agent` factory on EntityDefinition
- `effects` on EntityDefinition
- `createEffect` / `EffectScope` / `effect.ts`
- `context` config on EntityDefinition
- `actions` on EntityDefinition
- The implicit agent loop in `processWebhookWake` (SSE tail → processMessage → idle timer)
- Auto-context assembly as the default path
- Effect-related test cases (from `wake-handler.test.ts` and any effect-specific tests)

## What Gets Added

- `Wake` type, `WakeMessage` type
- `WakeRegistration` type
- `LoaderContext` / `HandlerContext` interfaces
- `WakeEvent` type
- Wake registry in `darix-manager.ts`
- Wake evaluation on stream append (post-ack)
- Wake conformance tests
- `toMessages()` and other context construction helpers (optional, for common patterns)

## What Gets Modified

- `types.ts` — EntityDefinition, context types
- `setup-context.ts` → becomes LoaderContext/HandlerContext factory
- `process-wake.ts` → simplified: materialize → loader → handler → idle/sleep
- `wake-handler.ts` → simplified: no setup phase, no agent factory
- `define-entity.ts` — accepts new definition shape
- `create-handler.ts` — passes wake options through to server
- `darix-manager.ts` — wake registry + evaluation
- `runtime-dsl.ts` — test DSL accepts new shapes
- `runtime-dsl.test.ts` — all 72 tests converted
- `index.ts` — updated exports

## Implementation Order (Vertical Slices)

1. Add `Wake` type + `wake` option to spawn/observe/connectSharedState signatures
2. Add wake registry to server (darix-manager.ts) — store, evaluate on post-ack append, inject WakeEvents
3. Write conformance tests for wake delivery
4. Wire runtime: EntityDefinition with loader/handler, LoaderContext/HandlerContext, new wake processing pipeline
5. Convert DSL tests slice by slice (basic lifecycle → coordination → blackboard)
6. Convert playground examples (replace `src/` with `src-revised/` contents) and playground tests
7. Delete dead code (effect.ts, old agent factories, old definition shape)

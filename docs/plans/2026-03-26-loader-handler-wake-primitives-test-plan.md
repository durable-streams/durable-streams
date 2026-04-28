# Loader/Handler Architecture + Wake Primitives Test Plan

## Harness requirements

### H1: Wake-aware runtime DSL (`runtime-dsl.ts`)

**What it does:** Extends the existing `RuntimeTestBuilder` to accept `NewEntityDefinition` (loader/handler shape) and pass `wake` options through spawn.

**What it exposes:**

- `define(name, definition)` accepts both old and new entity definition shapes
- `spawn(typeName, instanceId, args?, opts?)` passes `wake` through to server
- `waitForWake(predicate?, timeoutMs?)` on `RuntimeEntityRef` waits for wake-type events
- All existing assertions remain (waitForRun, waitForRunCount, history, snapshot, etc.)

**Estimated complexity:** Low -- property additions and a new predicate helper on existing infrastructure.

**Which tests depend on it:** All runtime DSL tests (tests 3-20).

### H2: Wake-enabled DarixManager (server integration surface)

**What it does:** The `WakeRegistry` class and its integration into `DarixManager` form the server-side surface that conformance tests exercise.

**What it exposes:**

- `register(reg)` / `evaluate(sourceUrl, event)` / `unregisterBySubscriber` / `rebuildFromManifests`
- Wake evaluation hooks into the `DarixManager` append path (post-durable-ack)
- WakeEvent injection into subscriber streams + webhook delivery

**Estimated complexity:** Medium -- new class plus integration into existing DarixManager (described in implementation plan Task 2).

**Which tests depend on it:** Server wake conformance tests (tests 1-2).

---

## Test plan

Tests are ordered by quality impact: server-side wake conformance first (they prove the fundamental primitive works, and everything downstream depends on them), then the DSL test conversion groups in dependency order (simplest entity lifecycle first, coordination patterns last), then dead code verification.

### 1. Wake on runFinished delivers WakeEvent to parent stream and webhook

- **Type:** integration
- **Disposition:** new
- **Harness:** Server conformance test (H2), extending `packages/server/test/conformance.test.ts` inside a new `describe("Wake Registry", ...)` block with its own `DurableStreamTestServer` configured with `{ port: 0, darix: true }`
- **Preconditions:** Server running with DARIX entity system enabled. Entity type registered with a `serve_endpoint` pointing at a local HTTP webhook receiver.
- **Actions:**
  1. Register entity type and create webhook receiver
  2. Spawn parent entity via typed spawn API
  3. Spawn child entity via typed spawn API with `wake: { subscriberUrl: parentUrl, condition: "runFinished" }`
  4. Append a run event with `status: "completed"` to child's main stream via direct HTTP PUT
  5. Read parent's main stream via HTTP GET
  6. Check webhook receiver for received notifications
- **Expected outcome:**
  - Parent's stream contains an event with `type: "wake"` and `source` matching child entity URL (source of truth: spec Section 1 WakeMessage type, Section 4 evaluation hot path)
  - Webhook receiver received a notification containing a WakeEvent with `payload.type === "wake"` (source of truth: spec Section 4 "WakeEvent delivery" -- same WakeEvent in both stream and webhook body)
- **Interactions:** DarixManager append path, webhook delivery pipeline, DurableStreams write acknowledgment

### 2. Wake conformance: spawn ordering, collection change, cleanup, timeout, debounce, restart rebuild

- **Type:** integration
- **Disposition:** new
- **Harness:** Server conformance test (H2), same `describe("Wake Registry", ...)` block
- **Preconditions:** Server running with DARIX entity system enabled
- **Actions and expected outcomes for each sub-test:**

  **2a. Spawn+wake ordering (no missed completion):**
  - Spawn child with `wake: "runFinished"` and an `initialMessage` that triggers immediate processing
  - Assert parent's stream gets WakeEvent even though child completes near-instantly
  - Source of truth: spec Section 1 "Registration lifecycle" -- server registers wake BEFORE creating child

  **2b. Wake on collection change:**
  - Register observation with `wake: { on: "change", collections: ["texts"] }`
  - Append a `texts`-type event to source stream
  - Assert subscriber stream gets WakeEvent with matching change
  - Source of truth: spec Section 1 Wake type, Section 4 collection match logic

  **2c. WakeEvent in stream and webhook body:**
  - Same setup as test 1, but explicitly compare the WakeEvent appended to subscriber's stream against the WakeEvent in the webhook body
  - Assert they contain the same `source`, `type`, and `payload` fields
  - Source of truth: spec Section 4 "WakeEvent delivery"

  **2d. Cleanup on entity deletion:**
  - Register wake, delete subscriber entity, append events to source
  - Assert no new WakeEvent appears in any stream
  - Source of truth: spec Section 1 "Entity deletion removes all registrations"

  **2e. Timeout delivery:**
  - Register with `timeoutMs: 2000`, wait 2.5s, assert WakeEvent with `payload.timeout: true, payload.changes: []`
  - Source of truth: spec Section 4 "Timeout"

  **2f. Debounce coalescing:**
  - Register with `debounceMs: 500`, append 3 rapid events within 200ms, wait 1s
  - Assert single WakeEvent with 3 changes in payload
  - Source of truth: spec Section 4 "Debounce"

  **2g. Wake registry rebuild on restart:**
  - Use `FileBackedStreamStore` (pass `dataDir` to `DurableStreamTestServer`)
  - Register wake, stop server, start fresh server at same `dataDir`
  - Trigger source event, assert subscriber still gets woken
  - Source of truth: spec Section 1 "rebuilt on server startup by scanning persisted entity manifests"

- **Interactions:** DarixManager entity lifecycle, DurableStreams persistence, webhook delivery, timer infrastructure

### 3. Group A: basic entity lifecycle with loader/handler (14 tests)

- **Type:** scenario
- **Disposition:** extend (converting existing passing tests to new entity definition shape)
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Runtime test server started with entity types registered using `NewEntityDefinition` shape (loader/handler). Fake agent adapters (`createCommandAssistantAdapter`, `createFakeToolAssistant`) continue working through the `AgentAdapterFactory` interface.
- **Actions:** Convert all 14 Group A entity definitions from old shape (`setup` + `agent` factory) to new shape (`loader` + `handler`). Each converted entity:
  - Loader calls `ctx.observe(ctx.entityUrl)`, `ctx.addContext(...toMessages(self.db, self.events))`
  - Handler calls `ctx.agent(adapter)` where applicable
  - Entities without agents have empty handler bodies

  Tests execute: spawn entity, send messages, wait for run completion, assert history snapshots.

- **Expected outcome:** All 14 tests pass with updated snapshots. Snapshot differences should be limited to:
  - No `manifest.agent` entry (agent no longer registered in manifest)
  - No `manifest.effect` entries
  - Source of truth: spec Section 2 "EntityDefinition" -- removed fields; implementation plan Task 7 conversion patterns
- **Interactions:** RuntimeHandler webhook processing, DarixManager spawn/send, DurableStreams append/read, `processWebhookWake` new loader/handler code path

### 4. Group B: spawn mechanics with loader/handler (4 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Group A conversion complete (entities it depends on are already converted)
- **Actions:** Convert Group B entity definitions. `ctx.spawn()` moves from old `setup()` to new `handler()`. Tests B1-B4 verify child entity creation, history, manifest entries, auto-observe.
- **Expected outcome:** All 4 tests pass. B4 (spawn auto-creates observe manifest entry) still works -- verify manifest structure matches new shape.
  - Source of truth: spec Section 2 "HandlerContext" -- `spawn` is on HandlerContext; implementation plan Task 8 step 1
- **Interactions:** Child entity materialization, manifest persistence, runtime-server-client spawn path

### 5. Group C: state collections with loader/handler (3 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Group A/B conversion complete
- **Actions:** Convert Group C entity definitions. State proxies are built from `EntityHandle.db` returned by `ctx.observe(ctx.entityUrl)` in loader, returned to handler.
- **Expected outcome:** All 3 tests pass. C1 (state inserts in stream), C2 (setup-initialized state visible), C3 (self-authored writes don't trigger second run) all work.
  - Source of truth: spec Section 2 "No pre-loaded state" -- state available after loader observes; implementation plan Task 8 step 2
- **Interactions:** StreamDB collection materialization, state proxy construction from EntityHandle.db

### 6. Group D: shared state with loader/handler (12 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Groups A-C complete
- **Actions:** Convert all 12 Group D entity definitions. Key changes:
  - `createSharedState` moves to loader behind `ctx.firstWake` guard
  - `connectSharedState` moves to loader, handle returned to handler
  - D9 (shared state effects) must be converted from `createEffect` on shared state to `wake: { on: "change" }` on `connectSharedState`
- **Expected outcome:** All 12 tests pass. D9 is the hardest -- it currently tests effect-driven reactions to shared state writes. With wake primitives, the entity should re-wake when the shared state collection changes, re-run loader+handler.
  - Source of truth: spec Section 1 "Wake on connectSharedState"; implementation plan Task 8 step 3 (specifically D9 note)
- **Interactions:** Shared state creation/connection, WakeRegistry collection watches, cross-entity stream coordination

### 7. Group E: observation replay with loader/handler (3 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Groups A-D complete, wake registry functional
- **Actions:** Convert Group E entity definitions. Replace `createEffect` observation patterns with `observe(url, { wake: { on: "change", collections: [...] } })`.
- **Expected outcome:** All 3 tests pass. E1 (no duplicated old rows after re-wake), E2 (single derived row key on update), E3 (update replayed as update not insert) all verify replay correctness.
  - Source of truth: spec Section 1 collection change watches; implementation plan Task 8 step 4
- **Interactions:** Wake evaluation on collection changes, StreamDB observation replay, manifest offset tracking

### 8. Group F: coordination orchestration with wake primitives (12 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Groups A-E complete, wake primitives working end-to-end
- **Actions:** Convert all 12 Group F entity definitions. Critical pattern change:
  - Old: parent spawns child with `createEffect`, child completes, effect fires self-message, SSE tail picks up, all in one run
  - New: parent handler spawns child with `wake: "runFinished"`, handler returns, server injects WakeEvent, parent re-wakes with fresh loader+handler
  - `waitForRunCount` assertions need updating (initial run + one per child wake)
- **Expected outcome:** All 12 tests pass. F1-F12 (dispatcher, manager-worker, variations) all work with multi-wake lifecycle.
  - Source of truth: spec Section 3 "Post-handler lifecycle"; implementation plan Task 9 "Critical pattern change"
- **Interactions:** WakeRegistry runFinished evaluation, multi-wake entity lifecycle, StreamDB replay across wakes

### 9. Group G: map-reduce with wake primitives (4 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Group F complete (coordination patterns established)
- **Actions:** Convert Group G. Map-reduce spawns N chunk workers and waits for all to complete. Each child completion triggers a separate wake (or a batch if they complete together).
- **Expected outcome:** All 4 tests pass. G1 (results in chunk order), G2 (single chunk), G3 (reuse children across wakes), G4 (failed chunk placeholder).
  - Source of truth: spec Section 3; implementation plan Task 9 step 2
- **Interactions:** Multiple concurrent child completions, wake delivery ordering

### 10. Group H: pipeline sequencing with wake primitives (6 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Group G complete
- **Actions:** Convert Group H. Pipeline spawns stages sequentially; each stage completion triggers the next. The simplified pipeline (reduced from 160 to 80 lines) uses `run_stage` tool that spawns one worker with `wake: "runFinished"`.
- **Expected outcome:** All 6 tests pass. H1-H6 verify state persistence, stage-by-stage progression, reuse across wakes, failed stage handling.
  - Source of truth: spec Section 3; implementation plan Task 9 step 3
- **Interactions:** Sequential wake chains (stage 1 completes -> parent wakes -> spawns stage 2 -> etc.)

### 11. Group M: researcher coordination with wake primitives (3 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Groups F-H complete
- **Actions:** Convert Group M. Researcher spawns specialist sub-agents with `wake: "runFinished"`.
- **Expected outcome:** All 3 tests pass. M1 (workers from initialMessage), M2 (wait_for_results before spawning), M3 (isolated child results across wakes).
  - Source of truth: spec Section 3; implementation plan Task 9 step 4
- **Interactions:** Specialist child entities, wake-driven result collection

### 12. Group I: peer review with wake primitives (4 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Shared state (Group D) and coordination (Group F) working
- **Actions:** Convert Group I. Peer review uses shared state with wake-on-change for reviewer writes.
- **Expected outcome:** All 4 tests pass. I1 (aggregates three reviewers), I2 (empty-state error path), I3/I4 (partial reviewer counts).
  - Source of truth: spec Sections 1-3; implementation plan Task 9 step 5
- **Interactions:** Shared state wake evaluation, multi-writer coordination

### 13. Group J: debate coordination with wake primitives (3 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Shared state and coordination working
- **Actions:** Convert Group J. Debate uses shared state with wake-on-change for argument writes.
- **Expected outcome:** All 3 tests pass. J1 (reads both sides before ruling), J2 (empty-state error), J3 (partial until missing side arrives).
  - Source of truth: spec Sections 1-3; implementation plan Task 9 step 6
- **Interactions:** Shared state change detection, partial-data handling

### 14. Group K: wiki coordination with wake primitives (10 tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Shared state and coordination working
- **Actions:** Convert Group K. Wiki spawns specialists with `wake: "runFinished"` and uses shared state. The old `createEffect` calls for child completion are removed.
- **Expected outcome:** All 10 tests pass. K1-K10 cover specialist accumulation, idempotent recreation, status reporting, empty-state messages, durable metadata, expansion.
  - Source of truth: spec Sections 1-3; implementation plan Task 9 step 7
- **Interactions:** Complex multi-entity coordination, shared state + child completion wakes

### 15. Group L: reactive observation with wake primitives (5+ tests)

- **Type:** scenario
- **Disposition:** extend
- **Harness:** Wake-aware runtime DSL (H1)
- **Preconditions:** Wake registry collection change watches working (validated in tests 2b, 7)
- **Actions:** Convert Group L. Replace all `createEffect` observation patterns with `observe(url, { wake: { on: "change", collections: [...] } })`. L1-L5 test insert/update/delete forwarding, deduplication across wakes, delete replay, watching same child twice, multi-child source attribution.
- **Expected outcome:** All 5+ tests pass with multi-wake lifecycle. L1 (forwarding notices), L2 (no duplicate after re-wake), L3 (delete replay), L4 (dedup same child), L5 (multi-child attribution).
  - Source of truth: spec Section 1 collection change watches; implementation plan Task 9 step 8
- **Interactions:** Collection-level wake evaluation, observation replay across wakes, manifest offset tracking

### 16. TypeScript compilation gate

- **Type:** invariant
- **Disposition:** new
- **Harness:** Direct `pnpm tsc --noEmit` execution
- **Preconditions:** All code changes from Tasks 1-11 complete
- **Actions:**
  1. `cd packages/ts-darix-runtime && pnpm tsc --noEmit`
  2. `cd packages/server && pnpm tsc --noEmit`
- **Expected outcome:** Both compile with zero errors.
  - Source of truth: implementation plan "Verification strategy" -- TypeScript compilation is a secondary check
- **Interactions:** Cross-package type references between runtime and server packages

### 17. Dead code removal verification

- **Type:** invariant
- **Disposition:** new
- **Harness:** Direct file system checks + grep
- **Preconditions:** All test groups passing, Task 11 complete
- **Actions:**
  1. Verify `packages/ts-darix-runtime/src/effect.ts` does not exist
  2. Verify `packages/ts-darix-runtime/src/wake-handler.ts` does not exist
  3. Verify `packages/ts-darix-runtime/test/effect.test.ts` does not exist
  4. Verify `packages/ts-darix-runtime/test/wake-handler.effects.test.ts` does not exist
  5. Verify `packages/ts-darix-runtime/test/wake-handler.test.ts` does not exist
  6. Grep for `createEffect`, `EffectScope`, `SetupContext` (as interface/class, not in comments/docs) in `packages/ts-darix-runtime/src/` -- assert zero matches
  7. Grep for `NewEntityDefinition` in `packages/ts-darix-runtime/src/` -- assert zero matches (renamed to `EntityDefinition`)
  8. Run full test suite: `pnpm vitest run --project darix-runtime` and `pnpm vitest run --project server`
- **Expected outcome:** All files deleted, no stale references, all tests pass.
  - Source of truth: implementation plan Task 11 "Delete dead code and finalize types"
- **Interactions:** Import resolution across the package

### 18. Full regression suite

- **Type:** regression
- **Disposition:** extend
- **Harness:** Full vitest project suite
- **Preconditions:** All individual group conversions complete
- **Actions:**
  1. `pnpm vitest run --project darix-runtime` -- all 83+ tests across all groups
  2. `pnpm vitest run --project server` -- all existing + new wake conformance tests
- **Expected outcome:** All tests pass. No pre-existing tests broken. Any snapshot changes are legitimate (removed manifest.agent/effect entries, event ordering).
  - Source of truth: CLAUDE.md "All Tests Must Pass"; implementation plan verification strategy
- **Interactions:** Complete system integration across runtime, server, DurableStreams

### 19. Context factory unit tests

- **Type:** unit
- **Disposition:** extend (rewriting setup-context.test.ts for new context factory)
- **Harness:** Vitest unit test, mocked dependencies
- **Preconditions:** `context-factory.ts` created (Task 5)
- **Actions:** Rewrite `setup-context.test.ts` to test `createContexts()`:
  1. `ctx.firstWake` is `true` when manifests collection is empty
  2. `ctx.addContext(string)` wraps string as `{ role: "user", content: string }`
  3. `ctx.addContext(LLMMessage)` passes through as-is
  4. `ctx.context` returns all accumulated messages
  5. `ctx.agent(factory)` calls adapter factory with correct config and returns `AgentRunResult`
  6. `ctx.sleep()` sets flag readable via `getSleepRequested()`
  7. `ctx.spawn(type, id, args, { wake })` passes wake through to doSpawn callback
  8. `ctx.observe(url, { wake })` passes wake through to doObserve callback
- **Expected outcome:** All unit tests pass, covering the context factory contract.
  - Source of truth: spec Section 2 LoaderContext/HandlerContext; implementation plan Task 5
- **Interactions:** None (unit tests with mocked callbacks)

### 20. toMessages helper unit tests

- **Type:** unit
- **Disposition:** new
- **Harness:** Vitest unit test
- **Preconditions:** `context-factory.ts` created with `toMessages` function
- **Actions:**
  1. Pass a StreamDB with user messages, assistant text, tool calls, and tool results
  2. Assert output matches expected LLM message format with correct roles
  3. Assert management events (entity_created, manifest, etc.) are filtered out
  4. Assert empty events array returns empty message array
- **Expected outcome:** `toMessages` correctly wraps `assembleContext(db, events, defaultContextPipeline)`.
  - Source of truth: implementation plan Task 5 `toMessages` definition; spec Section 2 "Context is explicitly built by the loader"
- **Interactions:** `assembleContext` from context-pipeline.ts, `coalesce` from coalesce.ts

---

## Coverage summary

### Covered

| Area                                                             | Tests         | Notes                                                 |
| ---------------------------------------------------------------- | ------------- | ----------------------------------------------------- |
| Server-side wake registry (register, evaluate, cleanup, rebuild) | 1, 2a-g       | New conformance tests, portable to caddy              |
| Basic entity lifecycle (loader/handler)                          | 3 (14 tests)  | Existing Group A, converted                           |
| Spawn mechanics                                                  | 4 (4 tests)   | Existing Group B, converted                           |
| State collections                                                | 5 (3 tests)   | Existing Group C, converted                           |
| Shared state                                                     | 6 (12 tests)  | Existing Group D, converted (incl. D9 wake-on-change) |
| Observation replay                                               | 7 (3 tests)   | Existing Group E, converted                           |
| Coordination orchestration                                       | 8 (12 tests)  | Existing Group F, multi-wake lifecycle                |
| Map-reduce                                                       | 9 (4 tests)   | Existing Group G, converted                           |
| Pipeline                                                         | 10 (6 tests)  | Existing Group H, converted                           |
| Deep researcher                                                  | 11 (3 tests)  | Existing Group M, converted                           |
| Peer review                                                      | 12 (4 tests)  | Existing Group I, converted                           |
| Debate                                                           | 13 (3 tests)  | Existing Group J, converted                           |
| Wiki                                                             | 14 (10 tests) | Existing Group K, converted                           |
| Reactive observation                                             | 15 (5+ tests) | Existing Group L, converted                           |
| TypeScript compilation                                           | 16            | Both runtime and server packages                      |
| Dead code removal                                                | 17            | File deletion + grep verification                     |
| Full regression                                                  | 18            | All 83+ DSL tests + server conformance                |
| Context factory                                                  | 19 (8 tests)  | Unit tests for createContexts                         |
| toMessages helper                                                | 20 (4 tests)  | Unit tests for context conversion                     |

### Explicitly excluded (per agreed strategy)

| Area                                      | Reason                                                                                                                                        | Risk                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Playground example TypeScript compilation | Examples are design sketches with types that don't exist yet in the runtime. Will produce expected errors.                                    | Low -- playground examples are not production code and will be fixed when types are finalized      |
| `process-wake.test.ts` detailed rewrite   | The DSL tests exercise the full processWebhookWake pipeline end-to-end at higher fidelity. The existing unit tests will be updated minimally. | Low -- DSL tests cover all integration paths                                                       |
| Caddy plugin wake support                 | Explicitly out of scope per user decision ("just the ts server for now"). Conformance tests ensure portability.                               | Medium -- caddy wake support is deferred but conformance tests define the contract                 |
| `AgentRunResult` field population         | Spec says `writes`, `toolCalls`, `usage` are stubs in v1. No test asserts their values.                                                       | Low -- side effects happen through OutboundBridge during agent loop; return values are bookkeeping |
| `loadReference` darix tool                | `ctx.darixTools` is an empty array in v1. The tool is a placeholder.                                                                          | Low -- design specifies the extension point; implementation deferred                               |
| Signal (`ctx.signal`)                     | Not yet implemented per user decision.                                                                                                        | None -- explicitly deferred                                                                        |

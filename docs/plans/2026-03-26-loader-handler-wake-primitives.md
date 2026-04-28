# Loader/Handler Architecture + Wake Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `setup() + agent factory + implicit agent loop + client-side effects` with `loader/handler + server-side wake primitives` in the DARIX runtime and dev server.

**Architecture:** Vertical slices — types first, then server-side wake registry with conformance tests, then runtime loader/handler context and wake processing pipeline, then incremental test conversion (one group at a time), then dead code removal. Each slice is independently testable.

**Tech Stack:** TypeScript, Vitest, Durable Streams dev server, existing OutboundBridge/AgentAdapterFactory/WakeSession infrastructure.

---

**Key design decisions (already made — do not revisit):**

- `loader(ctx, wake)` returns data to `handler(ctx, wake, loaded)` — TanStack Router pattern
- No `setup()` hook — `ctx.firstWake: boolean` in loader gates one-time work
- `ctx.agent(adapter)` is a callable step inside handler, not the orchestrator
- Wake primitives (`wake: "runFinished"` etc.) are declared on `spawn`/`observe`/`connectSharedState`
- Server evaluates wake conditions after durable write ack; registers wake before child creation
- WakeEvent is the universal envelope; WakeMessage is the payload for wake-type events
- Effects (`createEffect`/`EffectScope`) are deleted — server-side wakes replace them
- Context is explicitly built by the loader via `ctx.addContext()` and passed to handler via `ctx.context`
- `ctx.darixTools` provides built-in tools like `loadReference`
- Full stream materialization stays (no partial loading until checkpointing exists)

**Spec:** `docs/superpowers/specs/2026-03-26-loader-handler-wake-primitives-design.md`

## Verification strategy

**Primary automated checks:** The runtime DSL test suite (`packages/ts-darix-runtime/test/runtime-dsl.test.ts`, run via `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts`) is the authoritative verification. All 83 tests across 13 groups (A through M) must pass after conversion.

**Secondary automated checks:** `pnpm vitest run --project server` for server conformance tests (wake registry tests added here). TypeScript compilation via `cd packages/ts-darix-runtime && pnpm tsc --noEmit`.

**Execution is done when:** All DSL tests pass with the new loader/handler/wake shape, new wake conformance tests pass, TypeScript compiles cleanly, and dead code is removed.

---

## Task 1: Add Wake type system and WakeEvent types

**Files:**

- Modify: `packages/ts-darix-runtime/src/types.ts`

- [ ] **Step 1: Add new types at end of file (no removals yet)**

Append these types after the existing `SetupCompleteResult` interface, before the closing re-exports:

```typescript
// ── Wake Primitives ──────────────────────────────────────────────

export type Wake =
  | "runFinished"
  | {
      on: "change"
      collections?: string[]
      debounceMs?: number
      timeoutMs?: number
    }

export type WakeMessage = {
  type: "wake"
  source: string
  timeout: boolean
  changes: Array<{
    collection: string
    kind: "insert" | "update" | "delete"
    key: string
  }>
}

export type WakeEvent = {
  source: string
  type: string
  fromOffset: number
  toOffset: number
  eventCount: number
  payload?: unknown
  summary?: string
  fullRef?: string
}

export type AgentRunResult = {
  result?: unknown
  writes: Array<ChangeEvent>
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>
  usage: { tokens: number; duration: number }
}

export interface AgentTool {
  name: string
  description: string
  parameters: unknown
  execute: (...args: Array<unknown>) => unknown
}

// ── New Context Interfaces ────────────────────────────────────────

export interface LoaderContext {
  firstWake: boolean
  entityUrl: string
  observe: (url: string, opts?: { wake?: Wake }) => Promise<EntityHandle>
  addContext: (...items: Array<LLMMessage | string>) => void
  createSharedState: <TSchema extends SharedStateSchemaMap>(
    id: string,
    schema: TSchema
  ) => SharedStateHandle<TSchema>
  connectSharedState: <TSchema extends SharedStateSchemaMap>(
    id: string,
    schema: TSchema,
    opts?: { wake?: Wake }
  ) => SharedStateHandle<TSchema>
}

export interface HandlerContext extends LoaderContext {
  context: Array<LLMMessage>
  darixTools: Array<AgentTool>
  agent: (adapter: AgentAdapterFactory) => Promise<AgentRunResult>
  spawn: (
    type: string,
    id: string,
    args?: Record<string, unknown>,
    opts?: { initialMessage?: unknown; wake?: Wake }
  ) => Promise<EntityHandle>
  send: (entityUrl: string, payload: unknown, opts?: { type?: string }) => void
  sleep: () => void
}

// ── New EntityDefinition ──────────────────────────────────────────

export interface NewEntityDefinition<
  TState extends StateProxy = StateProxy,
  TLoaded = undefined,
> {
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

- [ ] **Step 2: Add `events` to `EntityHandle` interface**

The existing `EntityHandle` interface (line ~309 in `types.ts`) has `db: EntityStreamDB` but no raw events. Add `events: Array<ChangeEvent>` so `toMessages(self.db, self.events)` works. The raw events are collected during preload and stored on the handle.

```typescript
export interface EntityHandle {
  entityUrl: string
  type?: string
  db: EntityStreamDB
  events: Array<ChangeEvent> // raw events collected during preload
  run: Promise<void>
  text: () => Promise<Array<string>>
  send: (msg: unknown) => void
  status: () => ChildStatus | undefined
}
```

- [ ] **Step 3: Add `wake` field to manifest entry configs**

In `ManifestSpawnEntry.config`, add `wake?: Wake`. In `ManifestObserveEntry.config`, change from `Record<string, never>` to `{ wake?: Wake }`. In `ManifestSharedStateEntry.config`, add `wake?: Wake`.

- [ ] **Step 4: Add `wakeEvent` to WebhookNotification**

Add `wakeEvent?: WakeEvent` to the `WebhookNotification` interface.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd packages/ts-darix-runtime && pnpm tsc --noEmit`
Expected: PASS (all new types are additive, no existing code references them yet)

- [ ] **Step 6: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/src/types.ts
sleep 0.01 && git commit -m "feat: add Wake, WakeEvent, LoaderContext, HandlerContext types, add events to EntityHandle"
```

---

## Task 2: Add wake registry to dev server

**Files:**

- Create: `packages/server/src/wake-registry.ts`
- Modify: `packages/server/src/darix-manager.ts`
- Modify: `packages/server/src/darix-types.ts`

- [ ] **Step 1: Add `wake` to TypedSpawnRequest**

In `packages/server/src/darix-types.ts`, add to `TypedSpawnRequest`:

```typescript
wake?: {
  subscriberUrl: string
  condition: "runFinished" | { on: "change"; collections?: string[] }
  debounceMs?: number
  timeoutMs?: number
}
```

- [ ] **Step 2: Create `wake-registry.ts`**

```typescript
import type { ChangeEvent } from "@durable-streams/state"

export interface WakeRegistration {
  subscriberUrl: string
  sourceUrl: string
  condition: "runFinished" | { on: "change"; collections?: string[] }
  debounceMs?: number
  timeoutMs?: number
  oneShot: boolean
}

export interface WakeEvalResult {
  subscriberUrl: string
  wakeMessage: {
    type: "wake"
    source: string
    timeout: boolean
    changes: Array<{
      collection: string
      kind: "insert" | "update" | "delete"
      key: string
    }>
  }
}

export class WakeRegistry {
  private bySource = new Map<string, WakeRegistration[]>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private debounceBuffers = new Map<
    string,
    WakeEvalResult["wakeMessage"]["changes"]
  >()
  private timeoutTimers = new Map<string, NodeJS.Timeout>()

  register(reg: WakeRegistration): void {
    const existing = this.bySource.get(reg.sourceUrl) ?? []
    existing.push(reg)
    this.bySource.set(reg.sourceUrl, existing)

    if (reg.timeoutMs != null && reg.timeoutMs > 0) {
      const timerKey = `${reg.subscriberUrl}:${reg.sourceUrl}`
      const timer = setTimeout(() => {
        this.timeoutTimers.delete(timerKey)
        // Timeout callback will be wired in DarixManager
      }, reg.timeoutMs)
      this.timeoutTimers.set(timerKey, timer)
    }
  }

  unregisterBySubscriber(subscriberUrl: string): void {
    for (const [sourceUrl, regs] of this.bySource) {
      const filtered = regs.filter((r) => r.subscriberUrl !== subscriberUrl)
      if (filtered.length === 0) {
        this.bySource.delete(sourceUrl)
      } else {
        this.bySource.set(sourceUrl, filtered)
      }
    }
    // Clean up timers for this subscriber
    for (const [key, timer] of this.debounceTimers) {
      if (key.startsWith(`${subscriberUrl}:`)) {
        clearTimeout(timer)
        this.debounceTimers.delete(key)
        this.debounceBuffers.delete(key)
      }
    }
    for (const [key, timer] of this.timeoutTimers) {
      if (key.startsWith(`${subscriberUrl}:`)) {
        clearTimeout(timer)
        this.timeoutTimers.delete(key)
      }
    }
  }

  unregisterBySource(sourceUrl: string): void {
    const regs = this.bySource.get(sourceUrl)
    if (regs) {
      // Clean up timers for these registrations
      for (const reg of regs) {
        const timerKey = `${reg.subscriberUrl}:${reg.sourceUrl}`
        const debounceTimer = this.debounceTimers.get(timerKey)
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          this.debounceTimers.delete(timerKey)
          this.debounceBuffers.delete(timerKey)
        }
        const timeoutTimer = this.timeoutTimers.get(timerKey)
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          this.timeoutTimers.delete(timerKey)
        }
      }
      this.bySource.delete(sourceUrl)
    }
  }

  /**
   * Evaluate a newly-appended event against registered wake conditions.
   * Returns immediate wake results. Debounced wakes are buffered internally.
   */
  evaluate(
    sourceUrl: string,
    event: Record<string, unknown>
  ): WakeEvalResult[] {
    const regs = this.bySource.get(sourceUrl)
    if (!regs || regs.length === 0) return []

    const results: WakeEvalResult[] = []
    const toRemove: number[] = []

    for (let i = 0; i < regs.length; i++) {
      const reg = regs[i]!
      const match = this.matchCondition(reg, event)
      if (!match) continue

      // Cancel timeout timer on match
      const timerKey = `${reg.subscriberUrl}:${reg.sourceUrl}`
      const timeoutTimer = this.timeoutTimers.get(timerKey)
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        this.timeoutTimers.delete(timerKey)
      }

      const change = match

      if (reg.debounceMs != null && reg.debounceMs > 0) {
        // Buffer for debounce
        const buffer = this.debounceBuffers.get(timerKey) ?? []
        buffer.push(change)
        this.debounceBuffers.set(timerKey, buffer)

        // Reset debounce timer
        const existing = this.debounceTimers.get(timerKey)
        if (existing) clearTimeout(existing)
        // Debounce delivery is handled by DarixManager via onDebounce callback
      } else {
        results.push({
          subscriberUrl: reg.subscriberUrl,
          wakeMessage: {
            type: "wake",
            source: sourceUrl,
            timeout: false,
            changes: [change],
          },
        })
      }

      if (reg.oneShot) {
        toRemove.push(i)
      }
    }

    // Remove one-shot registrations (iterate in reverse to keep indices valid)
    for (let j = toRemove.length - 1; j >= 0; j--) {
      regs.splice(toRemove[j]!, 1)
    }
    if (regs.length === 0) {
      this.bySource.delete(sourceUrl)
    }

    return results
  }

  /**
   * Rebuild registry from persisted entity manifests on server startup.
   */
  rebuildFromManifests(
    entities: Array<{
      url: string
      manifests: Array<{
        kind: string
        key: string
        config: Record<string, unknown>
      }>
    }>
  ): void {
    this.bySource.clear()
    for (const entity of entities) {
      for (const entry of entity.manifests) {
        const wake = entry.config?.wake as
          | "runFinished"
          | { on: "change"; collections?: string[] }
          | undefined
        if (!wake) continue

        const sourceUrl =
          entry.kind === "spawn"
            ? (entry.config.entityUrl as string)
            : entry.key

        if (!sourceUrl) continue

        this.register({
          subscriberUrl: entity.url,
          sourceUrl,
          condition: wake,
          oneShot: wake === "runFinished",
        })
      }
    }
  }

  /** Flush any pending debounce buffers for a subscriber and return them. */
  flushDebounce(
    subscriberUrl: string,
    sourceUrl: string
  ): WakeEvalResult | null {
    const timerKey = `${subscriberUrl}:${sourceUrl}`
    const buffer = this.debounceBuffers.get(timerKey)
    if (!buffer || buffer.length === 0) return null
    this.debounceBuffers.delete(timerKey)
    const timer = this.debounceTimers.get(timerKey)
    if (timer) {
      clearTimeout(timer)
      this.debounceTimers.delete(timerKey)
    }
    return {
      subscriberUrl,
      wakeMessage: {
        type: "wake",
        source: sourceUrl,
        timeout: false,
        changes: buffer,
      },
    }
  }

  private matchCondition(
    reg: WakeRegistration,
    event: Record<string, unknown>
  ): {
    collection: string
    kind: "insert" | "update" | "delete"
    key: string
  } | null {
    if (reg.condition === "runFinished") {
      // Check for run event with terminal status
      if (event.type !== "run") return null
      const value = event.value as Record<string, unknown> | undefined
      const headers = event.headers as Record<string, unknown> | undefined
      const status = value?.status as string | undefined
      const operation = headers?.operation as string | undefined
      if (operation !== "update") return null
      if (status !== "completed" && status !== "failed") return null
      return {
        collection: "runs",
        kind: "update",
        key: (event.key as string) ?? "run",
      }
    }

    // Generic change condition
    const condition = reg.condition
    const eventType = event.type as string | undefined
    const headers = event.headers as Record<string, unknown> | undefined
    const operation = headers?.operation as string | undefined
    if (!eventType) return null

    if (condition.collections && condition.collections.length > 0) {
      // Match against collection names
      if (!condition.collections.includes(eventType)) return null
    }

    const kind: "insert" | "update" | "delete" =
      operation === "delete"
        ? "delete"
        : operation === "update"
          ? "update"
          : "insert"

    return {
      collection: eventType,
      kind,
      key: (event.key as string) ?? "",
    }
  }
}
```

- [ ] **Step 3: Integrate WakeRegistry into DarixManager**

In `packages/server/src/darix-manager.ts`:

1. Import `WakeRegistry` and `WakeEvalResult`.
2. Add `private wakeRegistry: WakeRegistry` field. Initialize in constructor: `this.wakeRegistry = new WakeRegistry()`.
3. In the `spawn()` method, when `req.wake` is present:
   - BEFORE `materializeEntity()` call (line ~403), register the wake:
   ```typescript
   if (req.wake) {
     this.wakeRegistry.register({
       subscriberUrl: req.wake.subscriberUrl,
       sourceUrl: entityURL,
       condition: req.wake.condition,
       debounceMs: req.wake.debounceMs,
       timeoutMs: req.wake.timeoutMs,
       oneShot: req.wake.condition === "runFinished",
     })
   }
   ```
4. Add a private method `evaluateWakes(sourceUrl, event)` that calls `this.wakeRegistry.evaluate()` and for each result: appends the WakeMessage to the subscriber's stream, then triggers a webhook notification.
5. Hook `evaluateWakes` into the `send()` method (after `streamStore.append` succeeds for any entity stream) and into any method that appends status-changing events (like run completion updates).
6. In the entity deletion path, call `this.wakeRegistry.unregisterBySubscriber(entityUrl)` and `this.wakeRegistry.unregisterBySource(entityUrl)`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd packages/server && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
sleep 0.01 && git add packages/server/src/wake-registry.ts packages/server/src/darix-manager.ts packages/server/src/darix-types.ts
sleep 0.01 && git commit -m "feat: add WakeRegistry to dev server with registration, evaluation, and cleanup"
```

---

## Task 3: Add wake conformance tests

**Files:**

- Modify: `packages/server/test/conformance.test.ts`

The conformance tests test the server's wake contract independently of the runtime. They use the existing `DurableStreamTestServer` and direct HTTP/stream operations.

- [ ] **Step 1: Write wake conformance tests**

Add a new `describe("Wake Registry", ...)` block to `packages/server/test/conformance.test.ts`. The block needs its own `DurableStreamTestServer` configured with `{ port: 0, darix: true }` since wakes require the DARIX entity system.

Each test:

1. Creates a parent entity via HTTP POST to the DARIX API
2. Creates a child entity with a `wake` registration (using the new `wake` field on the spawn request)
3. Triggers the condition (e.g., appending a run-completion event to the child's stream)
4. Asserts the parent's stream contains the expected WakeMessage event
5. Asserts the webhook notification was delivered

Tests to write:

- **Test 1: Wake on runFinished** — spawn child with `wake.condition: "runFinished"` on the spawn request body → append a run event with `status: "completed"` to child's stream → read parent's stream → assert it contains a WakeMessage event with `source` matching child URL
- **Test 2: Spawn+wake ordering (no missed completion)** — spawn child with `wake.condition: "runFinished"` and an `initialMessage` that causes the child to complete very quickly → assert parent's stream gets the WakeMessage (verifies registration before child creation)
- **Test 3: Wake on collection change** — register an observation with `wake.condition: { on: "change", collections: ["texts"] }` → append a `texts` type event to the source → assert subscriber stream gets WakeMessage
- **Test 4: WakeMessage in stream and webhook body** — same as test 1 but also verify the webhook notification body includes the WakeMessage
- **Test 5: Cleanup on entity deletion** — register wake → delete subscriber → append events to source → assert no new WakeMessage appears in any stream
- **Test 6: Wake registry rebuild on restart** — register wake → stop the `DurableStreamTestServer` → start a fresh `DurableStreamTestServer` pointing at the same data directory (use `FileBackedStreamStore` so data persists) → trigger the source → assert subscriber still gets woken. This requires using a file-backed server, not in-memory.
- **Test 7: Timeout delivery** — register with `timeoutMs: 2000` → wait 2.5s → assert WakeMessage with `timeout: true` appears in subscriber's stream
- **Test 8: Debounce coalescing** — register with `debounceMs: 500` → append 3 rapid events within 200ms → wait 1s → assert single WakeMessage with 3 changes

- [ ] **Step 2: Run tests and fix wake registry until all pass**

Run: `pnpm vitest run --project server packages/server/test/conformance.test.ts`
Expected: Some tests may fail initially. Fix `wake-registry.ts` and `darix-manager.ts` integration until all pass.

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server/test/conformance.test.ts packages/server/src/wake-registry.ts packages/server/src/darix-manager.ts
sleep 0.01 && git commit -m "test: add wake conformance tests; fix wake registry to pass"
```

---

## Task 4: Wire runtime to pass wake options to server

**Files:**

- Modify: `packages/ts-darix-runtime/src/runtime-server-client.ts`
- Modify: `packages/ts-darix-runtime/src/create-handler.ts`

- [ ] **Step 1: Add wake to SpawnEntityOptions**

In `runtime-server-client.ts`, add to `SpawnEntityOptions`:

```typescript
wake?: {
  subscriberUrl: string
  condition: "runFinished" | { on: "change"; collections?: string[] }
  debounceMs?: number
  timeoutMs?: number
}
```

Include the `wake` field in the spawn request body sent via `fetch`.

- [ ] **Step 2: Pass wake data from create-handler**

In `create-handler.ts`, the spawn handling path (where `spawnEntity` is called) needs to accept and forward `wake` options from the runtime context.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd packages/ts-darix-runtime && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/src/runtime-server-client.ts packages/ts-darix-runtime/src/create-handler.ts
sleep 0.01 && git commit -m "feat: wire wake options through runtime-server-client and create-handler"
```

---

## Task 5: Implement LoaderContext, HandlerContext factories, and toMessages helper

**Files:**

- Create: `packages/ts-darix-runtime/src/context-factory.ts`
- Modify: `packages/ts-darix-runtime/src/index.ts`

This task creates the new context objects that loader/handler functions receive. The context factory MUST delegate to the existing infrastructure in `setup-context.ts` — specifically the child DB creation, manifest persistence, shared state wiring, and spawn handle logic. Do NOT reimplement those.

- [ ] **Step 1: Create `context-factory.ts`**

**IMPORTANT — `assembleContext` signature:** The real function in `context-pipeline.ts` is `assembleContext(db, events, config)` with three positional arguments, where `config: ContextPipelineConfig` is mandatory (requires `query`, `coalesce`, `mapToMessage`). The default pipeline stages currently live in `wake-handler.ts` as `defaultContextPipeline` (line 67). Since `wake-handler.ts` is deleted in Task 11, the default pipeline must be extracted into `context-factory.ts` (or a shared location) during this task.

```typescript
import { assembleContext } from "./context-pipeline"
import { coalesce } from "./coalesce"
import { isManagementEvent } from "./entity-schema"
import { createOutboundBridge } from "./outbound-bridge"
import type {
  AgentAdapterFactory,
  AgentRunResult,
  AgentTool,
  ContextPipelineConfig,
  EntityHandle,
  EntityStreamDBWithActions,
  HandlerContext,
  LoaderContext,
  LLMMessage,
  NewEntityDefinition,
  PendingSend,
  SharedStateHandle,
  SharedStateSchemaMap,
  Wake,
  WakeEvent,
  WakeSession,
} from "./types"
import type { ChangeEvent } from "@durable-streams/state"

/**
 * Default context pipeline — extracted from wake-handler.ts since that file
 * is deleted later. Filters management events, coalesces into turns, maps
 * to LLM message format.
 */
const defaultContextPipeline: ContextPipelineConfig = {
  query: (_db, evts) => evts.filter((e) => !isManagementEvent(e)),
  coalesce,
  mapToMessage: (turn): LLMMessage => {
    switch (turn.kind) {
      case `user_message`:
      case `event`:
        return { role: `user`, content: turn.content }
      case `assistant_text`:
        return { role: `assistant`, content: turn.content }
      case `tool_call`:
        return {
          role: `tool_call`,
          content: turn.content,
          toolCallId: turn.key ?? ``,
          toolName: turn.toolName,
          toolArgs: turn.toolArgs,
        }
      case `tool_result`:
        return {
          role: `tool_result`,
          content: turn.content,
          toolCallId: turn.key ?? ``,
          isError: turn.isError,
        }
    }
  },
}

export interface ContextFactoryConfig {
  entityUrl: string
  entityType: string
  epoch: number
  args: Readonly<Record<string, unknown>>
  db: EntityStreamDBWithActions
  events: Array<ChangeEvent>
  writeEvent: (event: ChangeEvent) => void
  serverBaseUrl: string
  wakeSession: WakeSession
  wakeEvent: WakeEvent
  definition: NewEntityDefinition
  executeSend: (send: PendingSend) => void
  // Callbacks that delegate to existing setup-context.ts infrastructure:
  doObserve: (url: string, wake?: Wake) => Promise<EntityHandle>
  doSpawn: (
    type: string,
    id: string,
    args?: Record<string, unknown>,
    opts?: { initialMessage?: unknown; wake?: Wake }
  ) => Promise<EntityHandle>
  doCreateSharedState: <TSchema extends SharedStateSchemaMap>(
    id: string,
    schema: TSchema
  ) => SharedStateHandle<TSchema>
  doConnectSharedState: <TSchema extends SharedStateSchemaMap>(
    id: string,
    schema: TSchema,
    wake?: Wake
  ) => SharedStateHandle<TSchema>
}

export interface ContextResult {
  loaderCtx: LoaderContext
  handlerCtx: HandlerContext
  getSleepRequested: () => boolean
}

/**
 * `toMessages()` converts a StreamDB + its raw events into LLM messages
 * using the existing coalesce pipeline.
 *
 * Uses assembleContext(db, events, config) with the default pipeline stages
 * (filter management events, coalesce, map to LLM messages).
 *
 * The events array is required because StreamDB does not expose raw events —
 * they are collected separately during preload via the onEvent callback.
 * The loader receives them via the EntityHandle returned by ctx.observe().
 */
export function toMessages(
  db: EntityStreamDBWithActions,
  events: Array<ChangeEvent>
): LLMMessage[] {
  return assembleContext(db, events, defaultContextPipeline)
}

export function createContexts(config: ContextFactoryConfig): ContextResult {
  const contextMessages: LLMMessage[] = []
  let sleepRequested = false

  // firstWake: true when entity has no manifest entries yet
  // The entity_created event is always present, so we check manifests
  const manifests = config.db.collections.manifests?.toArray ?? []
  const firstWake = (manifests as Array<unknown>).length === 0

  const loaderCtx: LoaderContext = {
    firstWake,
    entityUrl: config.entityUrl,

    observe(url: string, opts?: { wake?: Wake }): Promise<EntityHandle> {
      return config.doObserve(url, opts?.wake)
    },

    addContext(...items: Array<LLMMessage | string>): void {
      for (const item of items) {
        if (typeof item === "string") {
          contextMessages.push({ role: "user", content: item })
        } else {
          contextMessages.push(item)
        }
      }
    },

    createSharedState<TSchema extends SharedStateSchemaMap>(
      id: string,
      schema: TSchema
    ): SharedStateHandle<TSchema> {
      return config.doCreateSharedState(id, schema)
    },

    connectSharedState<TSchema extends SharedStateSchemaMap>(
      id: string,
      schema: TSchema,
      opts?: { wake?: Wake }
    ): SharedStateHandle<TSchema> {
      return config.doConnectSharedState(id, schema, opts?.wake)
    },
  }

  // Stub darixTools — loadReference is a placeholder in v1
  const darixTools: AgentTool[] = []

  const handlerCtx: HandlerContext = {
    ...loaderCtx,

    get context(): LLMMessage[] {
      return contextMessages
    },

    darixTools,

    async agent(adapterFactory: AgentAdapterFactory): Promise<AgentRunResult> {
      const handle = adapterFactory({
        entityUrl: config.entityUrl,
        epoch: config.epoch,
        messages: contextMessages,
        events: config.events,
        writeEvent: config.writeEvent,
      })

      // The trigger message for processMessage comes from the WakeEvent.
      // For "message" type wakes, the payload contains the user's message text.
      // For "wake" type wakes, synthesize a system notification.
      // The adapter already has the full context via `messages` above;
      // processMessage provides the latest trigger text for the agent loop.
      const messageText =
        config.wakeEvent.type === "message"
          ? String(config.wakeEvent.payload ?? "")
          : `[Wake: ${config.wakeEvent.type} from ${config.wakeEvent.source}]`

      await handle.processMessage(messageText)

      // Collect results from bridge
      const writes: ChangeEvent[] = []
      const toolCalls: Array<{ name: string; args: unknown; result: unknown }> =
        []

      return {
        writes,
        toolCalls,
        usage: { tokens: 0, duration: 0 },
      }
    },

    async spawn(
      type: string,
      id: string,
      args?: Record<string, unknown>,
      opts?: { initialMessage?: unknown; wake?: Wake }
    ): Promise<EntityHandle> {
      return config.doSpawn(type, id, args, opts)
    },

    send(entityUrl: string, payload: unknown, opts?: { type?: string }): void {
      config.executeSend({ targetUrl: entityUrl, payload, type: opts?.type })
    },

    sleep(): void {
      sleepRequested = true
    },
  }

  return {
    loaderCtx,
    handlerCtx,
    getSleepRequested: () => sleepRequested,
  }
}
```

**Important notes on `ctx.agent()`:** The agent call wraps the existing `AgentAdapterFactory` → `AgentHandle` → `processMessage()` flow. The adapter factory already handles run lifecycle (run start/end, step start/end, text/tool events) via the OutboundBridge. The key insight is that `ctx.agent()` is equivalent to what the current `processWake` does in its agent loop — it creates the adapter, calls `processMessage()` with the trigger text, and returns. The difference is the handler controls when/whether to call it. **The `AgentRunResult` return value (`writes`, `toolCalls`, `usage`) is a stub in v1** — the side effects happen through the OutboundBridge during the agent loop, and no existing test checks these return fields. Populate them if straightforward, but do not block on it.

**Important notes on `toMessages()`:** The `assembleContext` function in `context-pipeline.ts` takes three positional arguments: `assembleContext(db, events, config)`. The `config: ContextPipelineConfig` is mandatory and requires `query`, `coalesce`, and `mapToMessage`. The default implementations are extracted from `wake-handler.ts` (line 67, `defaultContextPipeline`) into `context-factory.ts` as part of this task. `toMessages()` wraps `assembleContext` with these defaults.

**Important notes on event access:** The `toMessages` helper requires the raw events array. `StreamDB` / `EntityStreamDBWithActions` does NOT expose raw events — they are collected separately in `process-wake.ts` via the `onEvent` callback during `db.preload()` into `catchUpEvents`. The `EntityHandle` interface currently has `db` but not `events`.

**Solution:** Add an `events: Array<ChangeEvent>` property to `EntityHandle` (in `types.ts`). When `ctx.observe()` creates an EntityHandle (via `ensureObservedHandle` in `setup-context.ts`), it collects events during that observed entity's preload via the `onEvent` callback and stores them on the handle. For the self-observe case (`ctx.observe(ctx.entityUrl)`), the events are the same `catchUpEvents` already collected by `process-wake.ts` — the context factory must pass these through.

The loader then uses: `toMessages(self.db, self.events)` where `self` is the EntityHandle from `ctx.observe(ctx.entityUrl)`.

Add `events: Array<ChangeEvent>` to the `EntityHandle` interface in Task 1 alongside the other type additions.

- [ ] **Step 2: Export new symbols from index.ts**

Add to `packages/ts-darix-runtime/src/index.ts`:

```typescript
export { createContexts, toMessages } from "./context-factory"
export type { ContextFactoryConfig, ContextResult } from "./context-factory"
```

Also add new type exports:

```typescript
export type {
  Wake,
  WakeMessage,
  WakeEvent,
  LoaderContext,
  HandlerContext,
  AgentRunResult,
  AgentTool,
  NewEntityDefinition,
} from "./types"
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd packages/ts-darix-runtime && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/src/context-factory.ts packages/ts-darix-runtime/src/index.ts
sleep 0.01 && git commit -m "feat: add LoaderContext/HandlerContext factories and toMessages helper"
```

---

## Task 6: Rewrite wake processing pipeline + update test DSL

**Files:**

- Modify: `packages/ts-darix-runtime/src/process-wake.ts`
- Modify: `packages/ts-darix-runtime/test/runtime-dsl.ts`

This is the core change. The current `processWebhookWake` does: preload → claim epoch → handleWake (setup/replay/agent-create) → agent loop (SSE tail, processMessage, idle). The new flow is: preload → claim epoch → construct WakeEvent → loader → handler → idle/sleep.

- [ ] **Step 1: Add WakeEvent construction helper**

Add a function at the top of `process-wake.ts`:

```typescript
function constructWakeEvent(notification: WebhookNotification): WakeEvent {
  if (notification.wakeEvent) {
    return notification.wakeEvent
  }
  // Synthesize from existing notification fields for backward compat
  return {
    source: notification.entity?.url ?? notification.streamPath,
    type: notification.triggerEvent ?? "message",
    fromOffset: 0,
    toOffset: 0,
    eventCount: 0,
    payload: undefined,
  }
}
```

- [ ] **Step 2: Modify processWebhookWake to use loader/handler**

The key structural change in `processWebhookWake`:

1. Keep everything up to and including `db.preload()` and epoch claiming unchanged.
2. After `db.preload()` resolves and catch-up events are collected, determine which entity definition shape is being used. Check `'handler' in definition` (new shape) vs `'setup' in definition` (old shape). Both are functions, so a property existence check is sufficient. The dual path exists only during incremental test conversion (Tasks 7-9); after all tests are converted, the old path is deleted in Task 11.
3. For the new shape:
   a. Construct `WakeEvent` from notification via `constructWakeEvent()`
   b. Build the `ContextFactoryConfig`. For the delegation callbacks (`doObserve`, `doSpawn`, `doCreateSharedState`, `doConnectSharedState`), call `createSetupContext(...)` from `setup-context.ts` — it already sets up all the wiring (manifest persistence, child DB creation, shared state, send queue). Use its returned `ctx.observe`, `ctx.spawn`, `ctx.createSharedState`, `ctx.connectSharedState` as the delegation callbacks. The `WiringConfig` already exists in process-wake.ts — pass the same wiring through.

   Concretely:

   ```typescript
   const setupCtx = createSetupContext({
     entityUrl,
     entityType,
     epoch,
     args,
     db,
     events,
     definition: definition as EntityDefinition, // cast for compat
     writeEvent,
     serverBaseUrl,
     wiring,
     executeSend,
     wakeSession,
   })

   const contextConfig: ContextFactoryConfig = {
     entityUrl,
     entityType,
     epoch,
     args,
     db,
     events,
     writeEvent,
     serverBaseUrl,
     wakeSession,
     wakeEvent,
     definition: definition as NewEntityDefinition,
     executeSend: (send) => executeSend(send),
     doObserve: (url, wake) => setupCtx.observe(url),
     doSpawn: (type, id, spawnArgs, opts) =>
       setupCtx.spawn(type, id, spawnArgs, opts),
     doCreateSharedState: (id, schema) =>
       setupCtx.createSharedState(id, schema),
     doConnectSharedState: (id, schema, wake) =>
       setupCtx.connectSharedState(id, schema),
   }
   ```

   Note: The `wake` parameter on `doObserve` and `doConnectSharedState` needs to be forwarded to the server for wake registration. Since the current `createSetupContext` doesn't handle `wake`, the executor will need to plumb it through — either by extending the existing `observe`/`connectSharedState` signatures or by adding a separate server call for wake registration after the observe/connect completes.

   c. Call `createContexts(contextConfig)` to get `loaderCtx` and `handlerCtx`
   d. If `definition.loader` exists, call `const loaded = await definition.loader(loaderCtx, wakeEvent)`
   e. Call `await definition.handler(handlerCtx, wakeEvent, loaded)`
   f. After handler returns: check `getSleepRequested()`. If true → cleanup immediately. Otherwise → enter idle mode (use existing idle timer). On new `message_received` event during idle → construct new WakeEvent with `type: "message"` → re-run loader+handler.

4. For the old shape: keep existing `handleWake` + agent loop code path unchanged (this allows incremental test conversion).

**Critical detail on delegation:** The `doObserve`, `doSpawn`, etc. callbacks need to use the same manifest persistence, child DB creation, and shared state wiring that `setup-context.ts` provides. The simplest approach: call `createSetupContext(...)` internally to get the wiring infrastructure, then expose its methods through the callbacks. The `createSetupContext` function returns an object with `ctx.observe`, `ctx.spawn`, `ctx.createSharedState`, `ctx.connectSharedState` — these are exactly what the `do*` callbacks need.

- [ ] **Step 3: Update test DSL to accept both entity definition shapes**

In `packages/ts-darix-runtime/test/runtime-dsl.ts`:

1. Import `NewEntityDefinition` and `Wake` from `../src/index`.
2. Update `RuntimeTestBuilder.define()` to accept `EntityDefinition | NewEntityDefinition`:
   ```typescript
   define: (name: string, definition: EntityDefinition | NewEntityDefinition) =>
     RuntimeTestBuilder
   ```
3. Update `RuntimeTestBuilder.spawn()` to accept `opts?: { initialMessage?: unknown; wake?: Wake }` and pass wake through to the server client.
4. Add `waitForWake` helper to `RuntimeEntityRef`:
   ```typescript
   waitForWake: (
     predicate?: (event: RuntimeStreamEvent) => boolean,
     timeoutMs?: number
   ) => Promise<StreamHistory>
   ```
   Implementation: uses `waitForHistory` looking for events with `type === "wake"`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd packages/ts-darix-runtime && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/src/process-wake.ts packages/ts-darix-runtime/test/runtime-dsl.ts
sleep 0.01 && git commit -m "feat: add loader/handler code path to processWebhookWake, update test DSL"
```

---

## Task 7: End-to-end vertical slice — convert Group A tests

**Files:**

- Modify: `packages/ts-darix-runtime/test/runtime-dsl.test.ts` — entity definitions for Group A only (lines ~1-2490 for shared definitions, lines ~2491-2705 for Group A tests)

This task validates the entire pipeline works by converting the simplest test group first. Group A has 14 tests covering basic entity lifecycle: spawn, messages, runs, tool calls, state writes.

- [ ] **Step 1: Convert Group A entity definitions to new shape**

The test file has a single `const t = runtimeTest()` builder (line 166) and defines entities via `t.define(name, definition)` calls scattered through lines 167-2490.

Identify which entity definitions are used by Group A tests. Convert them from old shape to new shape:

**Pattern for entities WITH an agent:**

```typescript
// OLD:
t.define("echo", {
  setup(ctx) { /* spawn/observe/createEffect/createAgent calls */ },
  agent(ctx, config) { return createCommandAssistantAdapter({ ... }) },
})

// NEW:
t.define("echo", {
  async loader(ctx, wake) {
    const self = await ctx.observe(ctx.entityUrl)
    ctx.addContext(...toMessages(self.db, self.events))
  },
  async handler(ctx, wake) {
    await ctx.agent(createCommandAssistantAdapter({ ... }))
  },
})
```

**Pattern for entities WITHOUT an agent:**

```typescript
// OLD:
t.define("inbox-only", {
  setup(_ctx) {},
})

// NEW:
t.define("inbox-only", {
  async loader(ctx, _wake) {
    await ctx.observe(ctx.entityUrl)
  },
  handler(_ctx, _wake) {},
})
```

**Pattern for entities with state collections:**

```typescript
// OLD:
t.define("stateful", {
  state: { notes: { schema: noteRowSchema, ... } },
  setup(ctx) { /* use ctx.db.actions / ctx.db.collections for notes */ },
  agent(ctx, config) { return createAdapter({ notes: ctx.db.collections.notes }) },
})

// NEW:
t.define("stateful", {
  state: { notes: { schema: noteRowSchema, ... } },
  async loader(ctx, wake) {
    const self = await ctx.observe(ctx.entityUrl)
    ctx.addContext(...toMessages(self.db, self.events))
    return { notes: self.db.collections.notes }
  },
  async handler(ctx, wake, { notes }) {
    await ctx.agent(createAdapter({ notes }))
  },
})
```

**State proxy construction:** The current `setup-context.ts` (line 154) builds state proxies by wrapping `db.actions` and `db.collections`. The `EntityStreamDBWithActions` has both. In the new model, when the loader calls `ctx.observe(ctx.entityUrl)`, the returned `EntityHandle.db` is the `EntityStreamDBWithActions`. To get state proxies, the loader should call a helper that builds them from the DB — reuse the existing `buildStateProxy` logic from `setup-context.ts`.

The simplest approach: add a `buildStateProxy(db, stateDefinition)` export to `context-factory.ts` that wraps the DB's actions and collections into `StateCollectionProxy` objects (same logic as `setup-context.ts` lines 154-195). Then the loader returns them:

```typescript
// In loader:
const self = await ctx.observe(ctx.entityUrl)
return { notes: buildStateProxy(self.db, definition.state).notes }
```

Alternatively, if most entities just need all state collections proxied, the `EntityHandle` could expose a `.state` property that auto-builds proxies from its `.db`. But for v1, having the loader explicitly construct what it needs is cleaner and consistent with the "nothing automatic" principle.

- [ ] **Step 2: Import toMessages**

Add import at top of test file:

```typescript
import { toMessages } from "../src/index"
```

- [ ] **Step 3: Run Group A tests**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "A:"`
Expected: Some failures initially as the new code path exercises real end-to-end flow.

- [ ] **Step 4: Fix issues until Group A passes**

Debug failures. Common issues:

- `toMessages()` may not produce the same message format the adapters expect
- `ctx.agent()` may not correctly feed the trigger message text to `processMessage()`
- Manifest entries may be structured differently (no `agent` or `effect` entries)
- Snapshot assertions will need updating since event shapes change (no manifest agent entry, different ordering)

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "A:"`
Expected: All 14 Group A tests PASS

- [ ] **Step 5: Update snapshots where legitimate**

Run: `pnpm vitest run --project darix-runtime -u packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "A:"`

Verify each snapshot change is legitimate — the differences should be:

- No `manifest.agent` entry (agent is no longer registered in manifest)
- No `manifest.effect` entries
- Event ordering may differ slightly

- [ ] **Step 6: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/test/runtime-dsl.test.ts packages/ts-darix-runtime/src/
sleep 0.01 && git commit -m "feat: convert Group A tests to loader/handler — end-to-end vertical slice"
```

---

## Task 8: Convert Groups B-E (spawn, state, shared state, observation)

**Files:**

- Modify: `packages/ts-darix-runtime/test/runtime-dsl.test.ts`

Convert one group at a time. Run tests after each group to catch issues early.

- [ ] **Step 1: Convert Group B entity definitions and tests (spawn mechanics — 4 tests)**

Group B tests spawn mechanics. Convert entity definitions used by B1-B4.

Key change: `ctx.spawn()` in the old `setup()` becomes `ctx.spawn()` in the new `handler()`. The spawn still returns an `EntityHandle`.

Test B4 checks that spawn auto-creates an observe manifest entry — verify this still works with the new manifest structure.

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "B:"`
Expected: PASS

- [ ] **Step 2: Convert Group C entity definitions and tests (state collections — 3 tests)**

Group C tests `ctx.db.actions` inserts and `ctx.db.collections` reads. The key pattern: loader observes own stream and returns the state proxy to handler.

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "C:"`
Expected: PASS

- [ ] **Step 3: Convert Group D entity definitions and tests (shared state — 12 tests)**

Group D is the largest non-coordination group. Tests `createSharedState`, `connectSharedState`, multi-collection shared state, concurrent writers, etc.

Key changes:

- `createSharedState` moves to loader (behind `ctx.firstWake` guard)
- `connectSharedState` moves to loader
- Shared state handles returned from loader to handler
- D9 tests shared state effects — this test needs the most work: replace `createEffect` on shared state with `wake: { on: "change" }` on `connectSharedState`

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "D:"`
Expected: PASS (may need multiple fix iterations for D9)

- [ ] **Step 4: Convert Group E entity definitions and tests (observation replay — 3 tests)**

Group E tests observation replay across wakes. These use `createEffect` to observe child entities and react to changes. Convert to `observe(url, { wake: { on: "change", collections: [...] } })`.

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "E:"`
Expected: PASS

- [ ] **Step 5: Run all converted groups together**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "A:|B:|C:|D:|E:"`
Expected: All PASS

- [ ] **Step 6: Update snapshots for B-E where legitimate**

Run: `pnpm vitest run --project darix-runtime -u packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "B:|C:|D:|E:"`

- [ ] **Step 7: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/test/runtime-dsl.test.ts packages/ts-darix-runtime/src/
sleep 0.01 && git commit -m "feat: convert Groups B-E to loader/handler (spawn, state, shared state, observation)"
```

---

## Task 9: Convert Groups F-M (coordination, wake primitives)

**Files:**

- Modify: `packages/ts-darix-runtime/test/runtime-dsl.test.ts`

These tests use coordination patterns that fundamentally change with wake primitives. The current model has one long-lived wake with the SSE tail processing follow-up messages. The new model has multiple wake cycles — handler returns, entity idles, server-injected WakeEvent triggers fresh loader+handler.

**Critical pattern change:**

- **Current:** Parent spawns child with `createEffect`. Child completes → effect fires self-message → SSE tail picks up → `processMessage` → agent sees observation update. All in ONE run.
- **New:** Parent handler spawns child with `wake: "runFinished"`. Handler returns. Server injects WakeEvent. Parent re-wakes: fresh loader+handler cycle. Parent run count: N+1 (initial + one per child wake).

Tests that use `waitForRunCount(1)` expecting one run with multiple follow-up messages will need updating to `waitForRunCount(N+1)` or use `waitForWake()`.

- [ ] **Step 1: Convert Group F (coordination orchestration — 12 tests)**

F1 (dispatcher), F2 (manager-worker), F3-F12 (variations). These spawn children and wait for results.

Key changes:

- Replace `createEffect` with `wake: "runFinished"` on spawn calls
- Replace `effects` property on entity definition with nothing (effects are gone)
- Handler spawns children and returns. On re-wake with `wake.type === "wake"`, handler processes child results.
- `waitForRunCount` assertions need updating

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "F:"`

- [ ] **Step 2: Convert Group G (map-reduce — 4 tests)**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "G:"`

- [ ] **Step 3: Convert Group H (pipeline — 6 tests)**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "H:"`

- [ ] **Step 4: Convert Group M (researcher — 3 tests)**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "M:"`

- [ ] **Step 5: Convert Group I (peer review — 4 tests)**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "I:"`

- [ ] **Step 6: Convert Group J (debate — 3 tests)**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "J:"`

- [ ] **Step 7: Convert Group K (wiki — 10 tests)**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "K:"`

- [ ] **Step 8: Convert Group L (reactive observation — 5+ tests)**

Group L uses `createEffect` to observe external entities. Convert to `observe(url, { wake: { on: "change", collections: [...] } })`.

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts -t "L:"`

- [ ] **Step 9: Run ALL tests**

Run: `pnpm vitest run --project darix-runtime packages/ts-darix-runtime/test/runtime-dsl.test.ts`
Expected: All 83 tests PASS

- [ ] **Step 10: Update all snapshots**

Run: `pnpm vitest run --project darix-runtime -u packages/ts-darix-runtime/test/runtime-dsl.test.ts`
Verify each snapshot change is legitimate.

- [ ] **Step 11: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/test/runtime-dsl.test.ts packages/ts-darix-runtime/src/
sleep 0.01 && git commit -m "feat: convert Groups F-M to loader/handler with wake primitives"
```

---

## Task 10: Update remaining unit tests and delete dead test files

**Files:**

- Delete: `packages/ts-darix-runtime/test/effect.test.ts`
- Delete: `packages/ts-darix-runtime/test/wake-handler.effects.test.ts`
- Delete: `packages/ts-darix-runtime/test/wake-handler.test.ts`
- Modify: `packages/ts-darix-runtime/test/setup-context.test.ts` — rewrite for new context factory
- Modify: `packages/ts-darix-runtime/test/process-wake.test.ts` — update for new flow

Unit tests must be updated BEFORE deleting the source code they test (Task 11), because we need TypeScript to compile throughout.

- [ ] **Step 1: Delete dead test files**

Delete `effect.test.ts`, `wake-handler.effects.test.ts`, and `wake-handler.test.ts`.

- [ ] **Step 2: Rewrite setup-context.test.ts**

Rename conceptually to test `createContexts` from `context-factory.ts`. Update imports and test cases:

- Test `ctx.firstWake` derivation (true when manifests collection is empty)
- Test `ctx.addContext()` accumulates messages (strings become user messages)
- Test `ctx.context` returns accumulated messages
- Test `ctx.agent()` calls adapter factory and returns AgentRunResult
- Test `ctx.sleep()` sets flag (checked via `getSleepRequested()`)
- Test `ctx.spawn()` with `wake` option passes wake through
- Test `ctx.observe()` with `wake` option passes wake through
- Remove all tests for `createEffect`, `createAgent`, `SetupContext`

- [ ] **Step 3: Update process-wake.test.ts**

Update tests for the new loader→handler flow instead of setup→agent-loop.

- [ ] **Step 4: Run all unit tests**

Run: `pnpm vitest run --project darix-runtime`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/test/
sleep 0.01 && git commit -m "test: update unit tests for loader/handler, delete effect test files"
```

---

## Task 11: Delete dead code and finalize types

**Files:**

- Delete: `packages/ts-darix-runtime/src/effect.ts`
- Modify or delete: `packages/ts-darix-runtime/src/setup-context.ts` — keep only what `context-factory.ts` imports
- Delete: `packages/ts-darix-runtime/src/wake-handler.ts`
- Modify: `packages/ts-darix-runtime/src/types.ts` — rename `NewEntityDefinition` → `EntityDefinition`, remove old types
- Modify: `packages/ts-darix-runtime/src/index.ts` — update exports
- Modify: `packages/ts-darix-runtime/src/define-entity.ts` — use new `EntityDefinition`

- [ ] **Step 1: Delete `effect.ts` and `wake-handler.ts`**

These files are fully replaced by `context-factory.ts` and the updated `process-wake.ts`.

- [ ] **Step 2: Clean up `setup-context.ts`**

If `context-factory.ts` delegates to functions in `setup-context.ts`, keep those functions. Delete everything else (the `SetupContext` class, `createSetupContext`, etc.). If nothing in `setup-context.ts` is needed (all delegation is through `process-wake.ts` which creates its own wiring), delete the entire file.

- [ ] **Step 3: Rename `NewEntityDefinition` → `EntityDefinition`**

In `types.ts`: delete the old `EntityDefinition` interface. Rename `NewEntityDefinition` to `EntityDefinition`. Update all imports throughout the codebase (`define-entity.ts`, `context-factory.ts`, test DSL, test file).

- [ ] **Step 4: Remove dead type exports from types.ts**

Remove: `SetupContext`, `TriggerConfig`, `ContextPipelineConfig` (if no longer imported), `ManifestEffectEntry`, `ManifestAgentEntry` (if unused), `EffectConfig`, `EffectContext`, `Effect`, `EffectQueryInput`, `DeltaEvent` (the TanStack DB re-exports, if unused).

Keep: `RuntimeContext` (if still used by test adapters), `AgentHandle`, `AgentAdapterFactory`, `AgentAdapterConfig` (these are still used by `ctx.agent()`).

- [ ] **Step 5: Update index.ts exports**

Remove exports: `SetupContext`, `SetupContextConfig`, `SetupContextResult`, `EffectScope`, `EffectConfig`, `TriggerConfig`, `createSetupContext`, `handleWake`, `WakeConfig`, `WakeResult`.

Add exports (if not already added in Task 5): `Wake`, `WakeMessage`, `WakeEvent`, `LoaderContext`, `HandlerContext`, `AgentRunResult`, `AgentTool`, `createContexts`, `toMessages`.

- [ ] **Step 6: Update define-entity.ts**

Update `EntityRegistry` to use the new `EntityDefinition` type. Update `defineEntity` function signature and JSDoc.

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd packages/ts-darix-runtime && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `pnpm vitest run --project darix-runtime`
Expected: All PASS

Run: `pnpm vitest run --project server`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
sleep 0.01 && git add packages/ts-darix-runtime/src/ packages/ts-darix-runtime/test/
sleep 0.01 && git commit -m "refactor: delete effect.ts, wake-handler.ts, rename NewEntityDefinition → EntityDefinition"
```

---

## Task 12: Convert playground examples

**Files:**

- Delete: `examples/durable-agents-playground/src/` (old versions)
- Move: `examples/durable-agents-playground/src-revised/` → `examples/durable-agents-playground/src/`

- [ ] **Step 1: Review and fix revised examples**

Read each file in `src-revised/` and verify against the final API:

- Imports reference `NewEntityDefinition` (or just `EntityDefinition` after Task 11) and `toMessages`
- All spawn calls include `wake: "runFinished"` where parent needs child completion
- Loaders call `ctx.observe(ctx.entityUrl)` and `ctx.addContext(...toMessages(self.db))`
- Handlers call `ctx.agent()` with `context: ctx.context` and `tools: [...ctx.darixTools, ...entityTools]`
- No references to `createEffect`, `EffectScope`, `SetupContext`, `setup()`, or `agent()` factory

Fix any import or API mismatches.

- [ ] **Step 2: Move files**

```bash
rm -rf examples/durable-agents-playground/src
mv examples/durable-agents-playground/src-revised examples/durable-agents-playground/src
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd examples/durable-agents-playground && pnpm tsc --noEmit`
Expected: PASS (or expected errors for types that don't exist yet in the sketch files — document which ones)

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add examples/durable-agents-playground/
sleep 0.01 && git commit -m "feat: replace playground examples with loader/handler versions"
```

---

## Remember

- Use `pnpm` (not npm) for all operations
- Prefix git commands with `sleep 0.01 && ` to avoid lock issues
- Never create new test files without explicit permission — modify existing ones
- The runtime DSL test file (`runtime-dsl.test.ts`) is 177KB — work on it incrementally, one group at a time
- Snapshots will need regeneration after event shape changes — use `-u` flag, but verify each change is legitimate
- The test adapters (`createCommandAssistantAdapter`, `createFakeToolAssistant`) keep the existing `AgentAdapterFactory` interface — `ctx.agent()` wraps it
- `toMessages(db, events)` requires both the DB and the raw events array — `EntityHandle.events` carries the events. The function wraps `assembleContext(db, events, defaultContextPipeline)` with the default pipeline stages extracted from `wake-handler.ts`
- The wake registry rebuild-on-startup test is critical — it proves the in-memory cache is derived from durable state
- Do not weaken or delete valid tests to make them pass — fix the implementation
- `context-factory.ts` MUST delegate to existing wiring infrastructure — do NOT reimplement child DB creation, manifest persistence, or shared state wiring
- The old code path (setup/agent) must remain functional until all tests are converted — the dual-path support in process-wake.ts is temporary
- When converting entity definitions, carefully check how state is accessed via `ctx.db.actions` (writes) and `ctx.db.collections` (reads) — the `EntityHandle` from `observe()` has `.db` (StreamDB) but state proxies are a separate layer built in `setup-context.ts`

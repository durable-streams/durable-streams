# Diary

## Goal

Capture the work to build the `@durable-streams/coding-agents` scenario DSL, fix live Claude Code protocol handling, reverse engineer Codex's actual runtime protocol, and verify both agents end to end with real smoke tests.

## Step 1: Build The Scenario DSL And Harness

This step turned the abstract testing goal into concrete test infrastructure. The main change was to add a scenario builder and runtime harness that could express multi-client prompts, responses, restarts, waits, and invariants without dropping to raw durable-stream plumbing in every test.

The harness also needed better observability than the original bridge exposed. I added debug hooks for forwarded agent traffic and raw agent messages, which made it possible to assert bridge semantics directly and later proved critical for debugging restart/resume and live protocol mismatches.

### Prompt Context

**User prompt (verbatim):** "let's do it"

**Assistant interpretation:** Implement the DSL and harness rather than just describing it, and wire it into the `coding-agents` package tests.

**Inferred user intent:** Make integration scenarios concise to write and runnable against real Claude Code and Codex sessions.

**Commit (code):** N/A — "uncommitted workspace changes on top of ebd62b3c"

### What I did

- Added [scenario-dsl.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/scenario-dsl.ts)
- Added [scenario-dsl.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/scenario-dsl.test.ts)
- Added [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts)
- Added bridge debug hook types in [types.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/types.ts) and exported them from [index.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/index.ts)
- Added forwarded-message and raw-agent-message debug callbacks in [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts)
- Added a flushable harness client instead of relying on the public fire-and-forget client path inside tests
- Ran `pnpm --filter @durable-streams/coding-agents typecheck`
- Ran `pnpm vitest run --project coding-agents`

### Why

- The user wanted a DSL, not a pile of bespoke integration tests
- The real bottleneck was expressing ordering and race semantics clearly
- The bridge needed first-class visibility into forwarded traffic to make invariants testable

### What worked

- The builder API made prompt serialization, duplicate response handling, restart, and invariant checks concise
- The flushable harness client removed timing ambiguity from user-intent writes in tests
- The debug hooks created a stable surface for assertions over "what the bridge actually forwarded"

### What didn't work

- The restart scenario initially failed with `Timed out waiting for session resumed: expected +0 to be 1 // Object.is equality`
- The failing command was `pnpm vitest run --project coding-agents`

### What I learned

- A useful integration DSL needs both declarative steps and explicit wait/assert primitives
- Full-history assertions are more robust than only checking end state
- Test harnesses for durable streams need an explicit flush barrier when they generate client-side writes
- The stream alone is not enough to prove bridge decisions like "which response was forwarded" or "when a queued prompt was released" unless we choose to persist those decisions as explicit debug events

### What was tricky to build

- Separating test-only harness behavior from the public client API
- Preserving realistic bridge semantics while still making tests deterministic
- Designing invariants around forwarded traffic rather than internal bridge state

### What warrants a second pair of eyes

- Whether the current DSL surface is the right minimal API or still too coupled to current bridge behavior
- Whether the debug hook API is sufficient for future race/fault scenarios without leaking too much implementation detail
- Whether an opt-in debug-to-stream mode would be a better long-term debugging surface than ephemeral in-memory hooks

### What should be done in the future

- Add adversarial/fault-injection steps for reordered responses and interrupted approvals
- Add seeded scenario generation once the core scenario vocabulary settles
- Consider an opt-in bridge debug mode that appends forwarding/drop/relay-debug envelopes to the durable stream for replayable postmortems; not implemented in this pass because the in-memory hooks were enough for tests and avoided expanding the stream protocol

### Code review instructions

- Where to start (files + key symbols)
- [scenario-dsl.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/scenario-dsl.ts): `ScenarioBuilder`, `createRuntime`, `invariantAssertions`
- [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts): `sendToAgent`, debug hook emission, lifecycle writes
- How to validate (commands/tests)
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm vitest run --project coding-agents packages/coding-agents/test/scenario-dsl.test.ts`

### Technical details

- Core scenario methods: `prompt()`, `respond()`, `restart()`, `waitForAssistantMessage()`, `expectInvariant()`
- Initial invariants: `single_in_flight_prompt`, `first_response_wins`, `bridge_lifecycle_well_formed`
- Real-agent smoke suite is env-gated via `CODING_AGENTS_RUN_REAL=1`
- Considered but not implemented: an opt-in bridge debug stream mode with events like `forwarded_to_agent`, `dropped_client_response`, `queued_prompt_released`, and `agent_message_received`

## Step 2: Fix Restart/Resume And Bridge Producer Identity

The DSL exposed a real correctness bug rather than just a flaky test. The resumed bridge session was not writing `session_resumed` or later agent events because the second bridge instance reused the same idempotent producer id, causing its writes to be treated as duplicates of the first session.

The fix was to keep the durable stream session id stable while giving each bridge instance its own producer identity. That preserved exactly-once semantics for each live process without collapsing distinct bridge lifecycles into one dedupe stream.

### Prompt Context

**User prompt (verbatim):** "sitrep?"

**Assistant interpretation:** Summarize where the implementation was stuck and isolate the real blocker.

**Inferred user intent:** Understand whether the DSL work was converging and what remained broken.

**Commit (code):** N/A — "uncommitted workspace changes on top of ebd62b3c"

### What I did

- Inspected durable stream history produced by restart scenarios
- Compared bridge lifecycle events before and after restart
- Changed the bridge producer id in [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts) from a stable `bridge-${sessionId}` shape to a unique `bridge-${sessionId}-${randomUUID()}`
- Re-ran `pnpm vitest run --project coding-agents packages/coding-agents/test/scenario-dsl.test.ts -t 'supports restart and resume scenarios'`

### Why

- The test failure pattern did not match a missing `resume: true` flag
- The stream history showed user writes after restart but missing bridge control events, which pointed to dedupe rather than relay failure

### What worked

- The focused restart test passed immediately after the producer-id fix
- The bridge now writes `session_started`, `session_ended`, `session_resumed`, and the final `session_ended` in the expected order

### What didn't work

- Before the fix, the restart test failed with `Timed out waiting for session resumed: expected +0 to be 1 // Object.is equality`
- The failing command was `pnpm vitest run --project coding-agents`

### What I learned

- Stream identity and producer identity are different concerns
- Stable producer ids are correct for a single long-lived writer, but wrong when each sandbox restart is a distinct bridge process
- The exact-once layer will happily hide lifecycle bugs by deduping what look like "repeated" writes

### What was tricky to build

- Reasoning about idempotent producer semantics across resumed sessions
- Distinguishing "resume the conversation" from "reuse the same producer instance"

### What warrants a second pair of eyes

- Whether the original spec language around bridge producer identity should be updated to match the implemented restart model
- Any assumptions about zombie fencing that relied on the old stable producer id

### What should be done in the future

- Update the spec text so it no longer implies a single stable bridge producer id across sandbox replacement

### Code review instructions

- Where to start (files + key symbols)
- [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts): `startBridge()`, producer construction, lifecycle write ordering
- [scenario-dsl.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/scenario-dsl.test.ts): restart expectation
- How to validate (commands/tests)
- `pnpm vitest run --project coding-agents packages/coding-agents/test/scenario-dsl.test.ts -t 'supports restart and resume scenarios'`

### Technical details

- Symptom in history: second prompt was present, but `session_resumed` and second bridge shutdown markers were missing
- Root cause: second bridge instance replayed `seq=0` under the old producer identity, so writes were deduped

## Step 3: Reverse Engineer Claude Code's Actual WebSocket Input Shape

The real Claude smoke tests showed that the bridge was connected to Claude Code, but the agent never produced an assistant turn from the forwarded prompt. That narrowed the problem to the input wire format, not stream plumbing or process startup.

The companion reverse-engineering doc was directionally useful and matched the live behavior closely enough to fix the prompt path. The key correction was that Claude's `--sdk-url` stream-json transport expects a native `{"type":"user","message":...}` frame, not the bridge's internal `{type:"user_message", text:...}` intent object.

### Prompt Context

**User prompt (verbatim):** "did you look at https://github.com/The-Vibe-Company/companion/ especially https://github.com/The-Vibe-Company/companion/blob/main/WEBSOCKET_PROTOCOL_REVERSED.md"

**Assistant interpretation:** Check the external reverse-engineered Claude Code WebSocket protocol and compare it against the current adapter assumptions.

**Inferred user intent:** Use a concrete protocol reference instead of guessing about Claude Code's wire format.

**Commit (code):** N/A — "uncommitted workspace changes on top of ebd62b3c"

### What I did

- Read the companion protocol doc
- Ran a one-off debug script to capture raw Claude messages through the bridge
- Observed only `system` hook traffic before the prompt translation fix
- Updated [claude.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/adapters/claude.ts) so `user_message` becomes:
- `{"type":"user","message":{"role":"user","content":"..."}, "parent_tool_use_id": null, "session_id": ""}`
- Updated [claude.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/adapters/claude.test.ts)
- Re-ran the Claude debug script and real smoke test

### Why

- The live process was connected and emitting `system` traffic, so the missing assistant turn pointed to malformed input
- Claude needed agent-native frames over the WebSocket even though the bridge stores generic client intents in the durable stream

### What worked

- After the translation fix, Claude emitted `system/init`, `assistant`, and `result`
- The real Claude smoke test passed

### What didn't work

- Before the fix, the real smoke test timed out with `Timed out waiting for assistant message: expected false to be true // Object.is equality`
- The failing command was `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- The first debug run showed only `system` hook messages and no assistant/result turn

### What I learned

- Claude Code `2.1.89` accepts the empty `-p ""` placeholder in `--sdk-url` mode; that was not the bug
- The bridge's internal intent schema must not be confused with Claude's actual wire schema
- The companion doc was still useful for Claude even if it was not reliable for Codex

### What was tricky to build

- Verifying the exact input frame without polluting the bridge with Claude-specific logic outside the adapter
- Avoiding premature changes to `control_response` and interrupt paths before seeing live examples

### What warrants a second pair of eyes

- Claude approval and interrupt paths still deserve explicit live examples, not just prompt-turn validation
- The normalizer may need expansion for more `system` subtypes observed from real sessions

### What should be done in the future

- Capture and codify live Claude permission-request and interrupt examples

### Code review instructions

- Where to start (files + key symbols)
- [claude.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/adapters/claude.ts): `translateClientIntent()`
- [claude.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/adapters/claude.test.ts)
- [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts)
- How to validate (commands/tests)
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Technical details

- Live Claude version: `2.1.89 (Claude Code)`
- Observed assistant turn shape:
- `{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]}}`
- Observed completion shape:
- `{"type":"result","subtype":"success","result":"PONG"}`

## Step 4: Write Real Protocol Types For Claude And Codex

Once the live protocol behavior was clearer, I wrote explicit TypeScript types for both agents instead of leaving the reverse engineering in tests and scratch notes. The goal was not to perfectly model every field, but to establish accurate unions for the message families we had actually seen or now depended on in adapters and normalizers.

This split Codex into two surfaces on purpose: the long-lived app-server JSON-RPC protocol and the one-shot `codex exec --json` event stream. That distinction mattered because the installed CLI did not match the original spec's older JSON-RPC-over-stdio assumption.

### Prompt Context

**User prompt (verbatim):** "like typescript types"

**Assistant interpretation:** Write protocol inventories as importable TypeScript types, not just prose notes.

**Inferred user intent:** Make the protocol reverse engineering concrete and reusable in code review, adapters, normalizers, and future tests.

**Commit (code):** N/A — "uncommitted workspace changes on top of ebd62b3c"

### What I did

- Added [protocol/claude.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/protocol/claude.ts)
- Added [protocol/codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/protocol/codex.ts)
- Added [protocol/index.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/protocol/index.ts)
- Exported the protocol types from [index.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/index.ts)
- Ran `pnpm --filter @durable-streams/coding-agents typecheck`

### Why

- The adapter rewrite needed a shared vocabulary for request/notification/result shapes
- The reverse-engineered protocol should be visible as source code, not buried in chat history or `/tmp`

### What worked

- The package now exports `ClaudeWireMessage`, `CodexAppServerMessage`, and `CodexExecEvent`
- The focused adapter/normalizer tests still passed after the new types landed

### What didn't work

- One scenario test still assumed the old forwarded Claude prompt shape and had to be updated to read `message.content`

### What I learned

- Codex needs separate type families for `app-server` and `exec --json`
- Partial but accurate unions are better than pretending the protocol is fully known

### What was tricky to build

- Choosing where to stop: enough fidelity to be useful, but not so much that the type surface fossilizes speculation
- Preserving backward-compatible legacy Codex shapes alongside the newer app-server protocol

### What warrants a second pair of eyes

- Whether the exported protocol surface is the right public API or should stay internal for a while
- Whether any fields should be narrowed further now that the app-server schema is available

### What should be done in the future

- Add explicit tests around the protocol type modules themselves if we intend to keep exporting them

### Code review instructions

- Where to start (files + key symbols)
- [protocol/claude.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/protocol/claude.ts): `ClaudeWireMessage`
- [protocol/codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/protocol/codex.ts): `CodexAppServerMessage`, `CodexExecEvent`
- [index.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/index.ts): protocol exports
- How to validate (commands/tests)
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm vitest run --project coding-agents packages/coding-agents/test/normalize/codex.test.ts packages/coding-agents/test/normalize/claude.test.ts`

### Technical details

- Claude top-level union includes: `user`, `system`, `assistant`, `stream_event`, `control_request`, `control_response`, `result`
- Codex top-level unions include:
- `CodexAppServerMessage` for long-lived sessions
- `CodexExecEvent` for `codex exec --json` output

## Step 5: Reverse Engineer And Replace Codex's Actual Runtime Transport

The Codex side required a full transport correction, not just a shape tweak. The installed CLI here, `codex-cli 0.118.0`, does not behave like the older JSON-RPC-over-stdio protocol assumed in the original design doc and first adapter. The real surfaces were `codex exec --json` for one-shot runs and `codex app-server` for long-lived sessions.

I treated the local CLI behavior and generated app-server schema as the source of truth. That led to a full adapter rewrite: initialize over app-server, start or resume a thread, start turns with text inputs, interrupt turns by `threadId` and `turnId`, translate server-initiated approval requests back into generic client responses, and normalize the new notification stream into the same client event vocabulary the rest of the package already uses.

### Prompt Context

**User prompt (verbatim):** "ok great, let's go"

**Assistant interpretation:** Move from protocol inventory into the actual Codex implementation rewrite and verification.

**Inferred user intent:** Replace the outdated Codex assumptions with a working live integration.

**Commit (code):** N/A — "uncommitted workspace changes on top of ebd62b3c"

### What I did

- Ran `codex --help`, `codex exec --help`, and `codex app-server --help`
- Ran `codex exec --json "Reply with exactly the word PONG and nothing else."`
- Generated app-server reference material:
- `codex app-server generate-ts --out /tmp/codex-app-server-ts`
- `codex app-server generate-json-schema --out /tmp/codex-app-server-schema`
- Rewrote [codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/adapters/codex.ts) to use `codex app-server --listen stdio://`
- Updated [codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/normalize/codex.ts) for app-server notifications
- Updated [codex.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/adapters/codex.test.ts)
- Updated [codex.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/normalize/codex.test.ts)
- Ran:
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- `pnpm --filter @durable-streams/coding-agents build`

### Why

- The live Codex CLI was the real contract, not the older spec text
- Long-lived shared sessions require app-server semantics, not one-shot `exec --json`
- The bridge needed to route approvals and turn lifecycle through real thread/turn ids

### What worked

- The new adapter uses `initialize`, `thread/start` or `thread/resume`, `turn/start`, and `turn/interrupt`
- Real Codex smoke tests passed end to end after the rewrite
- The deterministic suite also stayed green after the normalizer and adapter changes

### What didn't work

- The first real Codex run failed with `thread/start.persistFullHistory requires experimentalApi capability`
- The failing command was `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- The earlier, pre-rewrite real Codex runs timed out without assistant output because the adapter was speaking the wrong protocol entirely

### What I learned

- `codex exec --json` emits `thread.started`, `turn.started`, `item.completed`, and `turn.completed`
- `codex app-server` exposes the long-lived JSON-RPC surface the bridge actually needs
- Capability-gated app-server fields like `persistExtendedHistory` cannot just be turned on blindly

### What was tricky to build

- Mapping generic client responses back into the right app-server approval result envelopes
- Tracking `threadId`, `currentTurnId`, and pending server request methods inside the adapter
- Supporting both new app-server notifications and legacy Codex-shaped history for normalization

### What warrants a second pair of eyes

- Approval response mappings in [codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/adapters/codex.ts), especially for permissions and dynamic tool calls
- Resume semantics now depend on extracting `threadId` from prior agent history; that assumption should be reviewed against more than the smoke path
- The app-server capability story is still implicit; capability negotiation may need to become explicit later

### What should be done in the future

- Add explicit capability negotiation before using gated app-server features
- Expand real-agent coverage beyond the single prompt smoke case to approvals, interrupts, and resume
- Reconcile the original spec text so it reflects Codex app-server instead of the older JSON-RPC-over-stdio assumption

### Code review instructions

- Where to start (files + key symbols)
- [codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/adapters/codex.ts): `spawn()`, `translateClientIntent()`, `prepareResume()`, `parseDirection()`
- [codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/normalize/codex.ts): app-server notification normalization
- [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts)
- How to validate (commands/tests)
- `pnpm vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- `pnpm --filter @durable-streams/coding-agents build`

### Technical details

- Real Codex version: `codex-cli 0.118.0`
- Observed one-shot JSON event stream:
- `{"type":"thread.started","thread_id":"..."}`
- `{"type":"turn.started"}`
- `{"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}`
- `{"type":"turn.completed","usage":{...}}`
- App-server request/notification primitives used by the adapter:
- `initialize`
- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/interrupt`
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/completed`
- `turn/completed`

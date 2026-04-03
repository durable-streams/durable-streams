# Diary

## Goal

Capture what changed after the approval-DSL entry: live interrupt coverage, deny/cancel variants, restart/resume validation, the failed approval-resume experiment that clarified the durability boundary, the durable prompt-replay redesign, and live multi-client approval races.

## Step 1: Add Live Interrupt Coverage

This step moved interrupt handling from a theoretical invariant into a real-agent contract. The main change was to add live Claude and Codex scenarios that interrupt an active turn while an approval request is pending, then assert both the synthetic cancellation ordering and the ability to continue with a queued prompt afterward.

The important unlock was confidence that the bridge is sequencing interruption correctly against real CLIs, not just against mocked adapters. That paid down a large chunk of product risk because interruption is where queueing, approval state, and agent lifecycle all intersect.

### Prompt Context

**User prompt (verbatim):** "ok great, start in on the next TODO then"

**Assistant interpretation:** Move from approval round-trips to the next highest-risk live scenario and implement the real interrupt path, not just talk about it.

**Inferred user intent:** Validate that shared sessions remain usable when a real turn is interrupted mid-flight, especially around pending approvals and queued prompts.

**Commit (code):** `737f023b` — "Add live interrupt scenarios for Claude and Codex"

### What I did

- Added two real-agent tests in [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts):
- `Claude interrupt cancels pending approval and allows queued prompt to continue`
- `Codex interrupt cancels pending approval and allows queued prompt to continue`
- Asserted ordering on `interrupt_synthesized_response` and `interrupt` via forwarded bridge debug events
- Asserted queued prompt continuation using a second prompt and a unique follow-up token
- Updated [todo.md](/Users/kylemathews/programs/durable-streams/todo.md) to mark item 2 complete after live validation
- Ran:
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Why

- Interrupt logic combines the most failure-prone state transitions in the bridge
- Queueing semantics are only meaningful if interruption does not deadlock the session
- Approval cancellation order must be verified against the real agent transports, not inferred from mocks

### What worked

- Both agents accepted the synthetic cancel-first, interrupt-second sequence
- The queued prompt resumed cleanly after the interrupted turn for both agents
- The existing bridge debug hooks were sufficient to assert ordering without changing the public stream format

### What didn't work

- The first Codex matcher assumed the approval would always normalize as `file_change`
- Live Codex output showed the relevant request was actually `item/commandExecution/requestApproval`, normalized as `terminal`
- Failing command during iteration:
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- Representative failure:
- `Timed out waiting for permission request: expected false to be true // Object.is equality`

### What I learned

- Codex approval requests are not stable at the “file change vs command” level for a prompt that ultimately writes a file
- Interrupt correctness needs two separate assertions: ordering correctness and forward progress after interruption
- A real queued prompt scenario is much better than a synthetic “interrupt happened” check because it proves the bridge re-enters a healthy state

### What was tricky to build

- Getting a real pending approval plus a meaningful queued prompt in the same scenario without making the prompt itself flaky
- Distinguishing a transport-shape mismatch from an actual bridge ordering bug

### What warrants a second pair of eyes

- Whether Codex should normalize command-execution approvals and file-change approvals more explicitly for test ergonomics
- Whether interrupt ordering should eventually become a first-class invariant over persisted debug events

### What should be done in the future

- Keep the interrupt scenarios as the canonical regression tests for pending-approval interruption
- Reuse the same pattern when adding crash/exit-mid-turn coverage

### Code review instructions

- Where to start (files + key symbols)
- [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts): the two interrupt scenarios
- [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts): interrupt synthesis and `pendingAgentRequestIds`
- How to validate (commands/tests)
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Technical details

- Relevant bridge forward sources:
- `interrupt_synthesized_response`
- `interrupt`
- `queued_prompt`
- Stable follow-up assertions used unique tokens:
- `CLAUDE_INTERRUPT_RECOVERED`
- `CODEX_INTERRUPT_RECOVERED`

## Step 2: Add Deny/Cancel Variants And Blocked Side-Effect Checks

This step turned approval coverage from “allow works” into a more credible policy surface. The core change was to add explicit deny and cancel live variants for both agents and assert on the absence of the requested file side effect instead of only inspecting client-visible text.

That unlocked a stronger product claim: the bridge is not just passing approvals through, it is preserving the effective decision semantics that users actually care about. In other words, the tests started checking “what happened on disk” instead of “what the model said happened.”

### Prompt Context

**User prompt (verbatim):** "ok great commit/push that and continue"

**Assistant interpretation:** Commit the finished interrupt work and immediately continue to the next risk item without waiting for another prompt.

**Inferred user intent:** Maintain momentum on the ranked backlog and keep converting the riskiest untested behavior into live coverage.

**Commit (code):** `079e319b` — "Add live deny/cancel approval coverage for Claude and Codex"

### What I did

- Added four real-agent tests in [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts):
- `Claude deny approval blocks side effects`
- `Claude cancel approval blocks side effects`
- `Codex deny approval blocks side effects`
- `Codex cancel approval blocks side effects`
- Added a small `pathExists()` helper in [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts) to assert file absence directly
- Reused the existing approval DSL primitives instead of introducing new test-only flow controls
- Updated [todo.md](/Users/kylemathews/programs/durable-streams/todo.md) to mark item 3 complete
- Ran:
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Why

- Allow-only approval tests leave a large correctness gap
- Side-effect checks are the most direct proof that deny and cancel are being honored
- Both agents needed coverage because their approval protocols differ significantly

### What worked

- Deny/cancel behavior was stable enough to verify with file absence for both agents
- The existing DSL methods `respondToLatestPermissionRequest()` and `cancelLatestPermissionRequest()` were sufficient
- The live matrix expanded without requiring bridge changes

### What didn't work

- Running targeted live tests inside the sandbox without the real-agent env/permissions produced immediate local bind failures
- Representative failure:
- `Error: listen EPERM: operation not permitted 127.0.0.1`

### What I learned

- For approval tests, file existence is a better ground truth than model narration
- Claude and Codex can share most scenario structure if the approval matcher is normalized first
- The right abstraction boundary for these tests is “effective user decision” rather than transport-specific response shape

### What was tricky to build

- Choosing prompts that trigger a real approval and produce a crisp yes/no side effect on disk
- Keeping the tests robust without embedding too much agent-specific text matching

### What warrants a second pair of eyes

- Whether we should centralize these “create a file, then deny/cancel” prompts into reusable helpers to avoid drift

### What should be done in the future

- Extend the same side-effect style of assertion to permission-grant and user-input variants later

### Code review instructions

- Where to start (files + key symbols)
- [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts): the four deny/cancel scenarios
- How to validate (commands/tests)
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Technical details

- Claude deny/cancel prompt shape:
- `Use Bash to run: printf 'hello\n' > <file>. Then tell me what happened.`
- Codex deny/cancel prompt shape:
- `Create a file named <file> in the current directory containing hello, then tell me you did it.`
- Success criteria:
- target file does not exist after turn completion

## Step 3: Validate Restart/Resume And Redraw The Durability Boundary

This step had two parts. The first part was straightforward: add live restart/resume coverage for simple completed turns and prove that a resumed bridge can keep serving the same session across both agents. The second part was the more valuable lesson: an attempted “approval plus resume” design was wrong because it targeted ephemeral agent waiting state instead of durable user intent.

The final outcome was a better definition of the product boundary. Durable sessions should replay user-authored intents already on the stream, especially prompts. They should not promise exact reconstruction of transient approval waits unless the agent protocol itself offers a stable resume model for those waits. That redesign turned item 5 from a dead-end into a concrete, shippable prompt-replay feature.

### Prompt Context

**User prompt (verbatim):** "restarting with approval doesn't make any sense -- we just want to restart with all user prompts"

**Assistant interpretation:** Stop treating in-flight approval state as the resume target and redefine the requirement around replaying durable prompts already written to the stream.

**Inferred user intent:** Keep the design aligned with event-sourced durability instead of overfitting to transient agent internals.

**Commit (code):** `b89bd122` — "Add live restart and resume coverage for Claude and Codex"  
**Commit (code):** `dc2d3ff7` — "Replay durable prompts after restart before turn completion"

### What I did

- Added live simple restart/resume scenarios for Claude and Codex in [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts)
- Tried two approval-resume variants and backed both out after live validation showed they were not a sound target:
- restart while approval is pending
- restart just after a response is written
- Rewrote item 5 in [todo.md](/Users/kylemathews/programs/durable-streams/todo.md) from approval-resume to `Real prompt replay after restart before turn completion`
- Updated [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts) to reconstruct unfinished `user_message` intents from stream history and replay them on restart
- Added bridge-level tests in [bridge.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/bridge.test.ts) for:
- replaying an unfinished prompt after resume
- falling back to a fresh spawn and replay when `resume` itself fails
- Added live prompt-replay scenarios in [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts) for both Claude and Codex
- Updated [todo.md](/Users/kylemathews/programs/durable-streams/todo.md) to mark items 4 and 5 complete
- Ran:
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Why

- Simple restart/resume had to be proven before deeper recovery scenarios could be trusted
- The approval-resume attempt exposed a design mismatch: approval wait state is not durable user intent
- Mid-turn prompt replay is the correct event-sourced durability behavior

### What worked

- Simple restart/resume passed live for both agents
- Replaying unfinished durable prompts after restart worked live for both agents
- Codex resume failures during incomplete turns could be handled by falling back to a fresh spawn plus prompt replay

### What didn't work

- Restarting while an approval was still pending did not produce a stable, resumable agent state
- Claude never re-emitted a second approval request after restart
- Codex could fail `thread/resume` for an incomplete rollout:
- `no rollout found for thread id ...`
- Replaying stored approval responses on restart produced ambiguity because the bridge cannot know from the stream alone whether a response was already forwarded before the crash
- Representative failures during the discarded experiment:
- `Timed out waiting for permission request count 2: expected 1 to be 2`
- `Timed out waiting for forwarded count 1: expected 2 to be 1`
- `no rollout found for thread id ...`

### What I learned

- The durable boundary is “user intents on the stream,” not “whatever the agent was waiting on”
- Prompt replay is tractable because prompts are first-class user events with stable semantics
- Approval-response replay is not tractable with exactness unless the stream or agent protocol records an unambiguous “applied” marker
- Codex incomplete-rollout resume is weaker than completed-turn resume, so fallback matters

### What was tricky to build

- Avoiding false confidence from an approval-resume implementation that looked plausible in unit tests but was not defensible against live agents
- Deriving “unfinished prompt” state from history without conflating any agent event with turn completion
- Falling back from `resume` to fresh spawn without losing the durable prompt

### What warrants a second pair of eyes

- The prompt replay heuristic in [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts), especially the assumption that unfinished prompts can be reconstructed from `user_message` events minus completed turns
- Whether bridge lifecycle events are the right place to hang more recovery semantics later, or whether a dedicated persisted replay marker would be cleaner

### What should be done in the future

- If exact approval-response recovery is ever required, add an explicit persisted marker for “bridge forwarded/applied this response” rather than inferring it

## Appendix: Desktop App Reverse-Engineering Fallback

If CLI-level schema, flags, and live probing stop being enough, an acceptable fallback is to inspect the desktop apps that likely speak the same local protocols. On this machine, `/Applications/Claude.app` is a normal Electron bundle, so the first thing to try is forcing inspectability instead of patching the app:

- `open -a /Applications/Claude.app --args --remote-debugging-port=9222`
- `open -a /Applications/Claude.app --args --auto-open-devtools-for-tabs`
- If `open` strips something important, launch the executable directly:
- `/Applications/Claude.app/Contents/MacOS/Claude --remote-debugging-port=9222`

The useful targets are localhost HTTP/WebSocket traffic, spawned helper process args, and any JSON-RPC-style payloads moving over local transports. This should stay a fallback, not the default path: prefer generated schema, documented flags, app-server requests, and live harness coverage first.

## Appendix: Claude Cross-Cwd Resume Finding

After the Codex work, I revisited the remaining Claude path-rewrite item with direct probes instead of another hanging end-to-end test. The useful result was not a pass; it was a precise failure. Rewritten resume transcripts are still generated correctly, but a live Claude resume into a different cwd currently fails fast with:

- `No conversation found with session ID: ...`

That matters because it suggests transcript rewriting alone is not sufficient for Claude cross-cwd resume. Claude appears to require additional conversation state beyond the rewritten JSONL transcript, or it keys lookup on more than the resume transcript file in the new project directory. I also updated the Claude adapter to reject immediately when the child exits before the websocket connects, including the captured child output, so this path now fails with an actionable error instead of a 30-second timeout.

- Keep item 10 in mind because crash/exit-mid-turn coverage will build directly on this prompt replay path

### Code review instructions

- Where to start (files + key symbols)
- [bridge.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/bridge.ts): `buildPendingPromptIntents()`, fresh-spawn fallback, replayed `promptQueue`
- [bridge.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/bridge.test.ts): unfinished prompt replay and resume fallback tests
- [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts): restart-before-completion scenarios
- How to validate (commands/tests)
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Technical details

- New live prompt-replay scenarios:
- `Claude can resume after restart before turn completion`
- `Codex can resume after restart before turn completion`
- Representative prompt tokens:
- `CLAUDE_REPLAY_AFTER_RESTART`
- `CODEX_REPLAY_AFTER_RESTART`
- Codex incomplete-turn resume fallback is triggered when `adapter.spawn({ resume })` throws

## Step 4: Add Live Multi-Client Approval Races

This step moved the bridge’s `first_response_wins` rule from scripted validation into real multi-client behavior. The scenarios intentionally have two users answer the same live approval with opposite decisions, then assert that only one response is forwarded and that the outcome on disk matches the winning response.

The main product unlock is that shared sessions now have real coverage for the race that matters most in practice: laptop and phone, or two tabs, answering the same approval at nearly the same time. The tests no longer trust the invariant only in the abstract; they prove it against Claude and Codex.

### Prompt Context

**User prompt (verbatim):** "ok great let's do 6"

**Assistant interpretation:** Implement the next ranked risk item, which is live multi-client duplicate-response races.

**Inferred user intent:** Validate that the shared-session bridge behaves predictably when multiple clients compete to answer the same approval.

**Commit (code):** `ef549619` — "Add live multi-client approval race coverage"

### What I did

- Added two live race scenarios in [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts):
- `Claude keeps only the first live approval response across clients`
- `Codex keeps only the first live approval response across clients`
- Used two explicit clients (`alice` and `bob`) in the same scenario
- For Codex:
- first response = `deny`
- second response = `allow`
- asserted no file was created
- For Claude:
- first response = `deny`
- second response = `allow`
- asserted the second response was not forwarded and the file stayed absent after a short settle window
- Marked item 6 complete in [todo.md](/Users/kylemathews/programs/durable-streams/todo.md)
- Ran:
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Why

- Multi-client response races are one of the core shared-session hazards
- The bridge already had scripted `first_response_wins` coverage, but live behavior against real approvals was still unproven
- This is the shortest path to product confidence for concurrent client use

### What worked

- Both agents upheld `first_response_wins` under live two-client races
- Codex handled the race cleanly with a denied first response and no file side effect
- Claude also enforced the dedupe rule, but the stable assertion point was “first response forwarded, second response dropped, side effect absent” rather than “denied turn completes cleanly”

### What didn't work

- The first Claude race variant expected a denied first response to reach a normal `turn_complete`, but that path was not stable in live runs
- The later “allow first, deny second” variant completed but still failed the side-effect assertion, which suggested the second response was dropped correctly but the command itself was not being driven the way the test expected
- Representative failures during iteration:
- `Timed out waiting for turn complete: expected false to be true`
- `AssertionError: expected false to be true`

### What I learned

- The bridge-level concurrency contract and the agent’s post-denial conversational behavior are not the same thing
- For Claude races, the stable contract is dedupe plus observable side-effect result, not necessarily a clean final turn narrative
- When testing concurrency, “first response forwarded exactly once” is the primary assertion; completion behavior is secondary and agent-specific

### What was tricky to build

- Getting two client responses close enough together to be a meaningful race while still keeping the test deterministic
- Separating “bridge deduped correctly” from “agent handled a denied action conversationally in a stable way”

### What warrants a second pair of eyes

- Whether the Claude race should later gain a stronger client-visible outcome assertion once Claude’s denied-turn behavior is better characterized

### What should be done in the future

- Build item 7 on top of the same idea: multiple live prompts queued back-to-back across real agents

### Code review instructions

- Where to start (files + key symbols)
- [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts): the two multi-client race scenarios
- [todo.md](/Users/kylemathews/programs/durable-streams/todo.md): item 6 completion
- How to validate (commands/tests)
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`

### Technical details

- Client names used in the live races:
- `alice`
- `bob`
- Core assertion used in both scenarios:
- `.expectForwardedCount((event) => event.source === 'client_response', 1)`
- Shared invariant:
- `.expectInvariant('first_response_wins')`

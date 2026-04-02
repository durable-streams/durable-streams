# Diary

## Goal

Capture the work to rank the next test risks, extend the scenario DSL for approval flows, and add the first real approval round-trip coverage for Claude Code and Codex.

## Step 1: Add Approval DSL Primitives And First Live Approval Tests

This step turned “approval flows” from a vague next item into concrete, reusable test vocabulary. The main change was to extend the scenario DSL so tests can wait for a normalized permission request, respond to the latest request without hard-coded ids, and assert the request/response path directly against real agents.

The other half of the work was live protocol validation. Claude and Codex both support approvals, but not under the same conditions. Claude produced a real `control_request` when asked to use `Bash` on an absolute path under `default` permissions. Codex only emitted a real `item/fileChange/requestApproval` after the adapter passed through the native `untrusted` approval policy instead of the older reduced mapping. Once those trigger conditions were clear, the first end-to-end approval suite became stable.

### Prompt Context

**User prompt (verbatim):** "ok great, write down a todo.md with these and start working through them"

**Assistant interpretation:** Persist the ranked testing backlog to the repo and begin implementing the highest-risk item immediately instead of only discussing it.

**Inferred user intent:** Systematically pay down the biggest remaining product and engineering risks, starting with live approval behavior.

**Commit (code):** N/A — "uncommitted workspace changes on top of ebd62b3c"

### What I did

- Added the ranked backlog in [todo.md](/Users/kylemathews/programs/durable-streams/todo.md)
- Extended [scenario-dsl.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/scenario-dsl.ts) with:
- `waitForPermissionRequest()`
- `respondToLatestPermissionRequest()`
- `cancelLatestPermissionRequest()`
- `expectPermissionRequest()`
- Added scripted coverage for the new DSL surface in [scenario-dsl.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/scenario-dsl.test.ts)
- Updated [codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/adapters/codex.ts) so `permissionMode` can pass through native app-server approval policies including `untrusted`, `on-request`, `on-failure`, and `never`
- Added real approval scenarios to [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts)
- Ran focused live debug probes with `/tmp/debug-coding-agents-real.ts` for Claude and Codex to capture real approval request shapes and post-response behavior
- Ran:
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- `pnpm --filter @durable-streams/coding-agents build`

### Why

- Approval handling is the highest-risk remaining shared-session behavior after basic prompt round trips
- Hard-coding request ids in tests would not scale to real multi-client or resumed-session scenarios
- Codex approval behavior could not be trusted without validating the actual app-server policy/settings that trigger approval requests

### What worked

- The DSL can now express “wait for the next permission request and answer it” without leaking raw ids into test bodies
- Claude approval requests normalized cleanly as `permission_request` events when the prompt forced real `Bash` approval
- Codex emitted real `item/fileChange/requestApproval` events once the adapter used `untrusted`
- The full live suite passed after aligning each test with the real trigger conditions it actually needed

### What didn't work

- A Codex probe under `auto` / `on-request` produced no approval request at all; it went straight to execution or file change planning
- A shell-quoted probe using backticks accidentally interpolated `` `pwd` `` before the agent ever saw it, which tested the wrong behavior
- Running Codex from an out-of-workspace temp cwd changed its sandbox to read-only and introduced extra approval behavior unrelated to the intended test
- Early live suite failures included:
- `Timed out waiting for turn complete: expected false to be true // Object.is equality`
- `Timed out waiting for permission request: expected false to be true // Object.is equality`
- `ENOENT: no such file or directory, open '/Users/kylemathews/programs/durable-streams/.tmp/.../approval-codex.txt'`
- Failing commands during iteration:
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- `pnpm exec tsx /tmp/debug-coding-agents-real.ts codex "..."`
- `pnpm exec tsx /tmp/debug-coding-agents-real.ts claude "..."`

### What I learned

- “Approval support exists” is too coarse. The important question is which prompts, cwd/sandbox settings, and permission policies actually produce approval requests
- Codex `app-server` approval behavior is policy-sensitive; `untrusted` is required for the first stable file-change approval path
- Claude approval prompts are more reliable when they force a concrete `Bash` action that clearly falls outside the default no-approval path
- A good approval DSL needs to target normalized semantics, not raw transport ids

### What was tricky to build

- Keeping the DSL agent-agnostic while still supporting very different Claude and Codex approval transports
- Distinguishing “the agent completed” from “the exact side effect I naively expected happened in this cwd/sandbox variant”
- Debugging live-agent failures where the test assumption was wrong but the protocol implementation was actually behaving correctly

### What warrants a second pair of eyes

- Whether the current Codex approval-response mapping should grow stronger assertions for file-change side effects, or whether the current stream/assistant-visible checks are the right stability point for now
- Whether approval triggers should be centralized as explicit fixtures/helpers so future live tests do not rediscover prompt-specific edge cases
- Whether `permissionMode` should be normalized more explicitly in shared types/docs now that Codex supports native app-server policy names

### What should be done in the future

- Implement item 2 from [todo.md](/Users/kylemathews/programs/durable-streams/todo.md): real interrupt behavior during an active turn
- Implement item 3 from [todo.md](/Users/kylemathews/programs/durable-streams/todo.md): real deny/cancel approval variants for both agents
- Add multi-client approval-race scenarios on top of the new DSL helpers
- Update the design/spec docs so they describe Codex’s approval-triggering behavior in terms of app-server policies, not the older assumptions

### Code review instructions

- Where to start (files + key symbols)
- [scenario-dsl.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/scenario-dsl.ts): `waitForPermissionRequestEvent`, `permissionRequestsFromSnapshot`, `respondToLatestPermissionRequest()`, `cancelLatestPermissionRequest()`
- [real-agents.test.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/test/real-agents.test.ts): the two new live approval scenarios
- [codex.ts](/Users/kylemathews/programs/durable-streams/packages/coding-agents/src/adapters/codex.ts): `mapApprovalPolicy()`
- How to validate (commands/tests)
- `pnpm --filter @durable-streams/coding-agents typecheck`
- `pnpm exec vitest run --project coding-agents`
- `CODING_AGENTS_RUN_REAL=1 pnpm vitest run --project coding-agents packages/coding-agents/test/real-agents.test.ts`
- `pnpm --filter @durable-streams/coding-agents build`

### Technical details

- Stable live Claude trigger used in the final test:
- Prompt: `Run /Users/kylemathews/programs/durable-streams using Bash and then tell me the output.`
- Approval request shape observed:
- `{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Bash",...}}`
- Stable live Codex trigger used in the final test:
- Prompt: `Create a file named approval-codex.txt in the current directory containing hello, then tell me you did it.`
- Permission mode: `untrusted`
- Approval request shape observed:
- `{"method":"item/fileChange/requestApproval","id":0,...}`
- Codex approval response forwarded by the bridge:
- `{"jsonrpc":"2.0","id":0,"result":{"decision":"accept"}}`
- The approval probes also showed that a temp cwd outside the workspace can change Codex’s sandbox shape from `workspaceWrite` to `readOnly`, which materially changes the scenario being tested

# @durable-streams/coding-agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript library and CLI that bridges Claude Code and Codex to durable streams, making coding agent sessions persistent, resumable, and shareable.

**Architecture:** A bridge process spawns an agent (Claude Code via WebSocket, Codex via stdio), records every raw protocol message to a durable stream as typed envelopes, and relays client messages back. A browser-safe client reads from the stream with agent-specific normalizers. Event sourcing: raw events on stream, normalization is a client-side projection.

**Tech Stack:** TypeScript, `@durable-streams/client` (DurableStream, IdempotentProducer), `ws`, vitest, tsdown

**Spec:** `docs/superpowers/specs/2026-04-01-coding-agents-design.md`

---

## File structure

```
packages/coding-agents/
  package.json
  tsdown.config.ts
  tsconfig.json
  src/
    index.ts                — exports createSession + types
    client.ts               — exports createClient (browser-safe)
    bridge.ts               — stream relay + prompt queue + lifecycle
    types.ts                — envelopes, JSON-RPC, shared types
    adapters/
      types.ts              — AgentAdapter, AgentConnection interfaces
      claude.ts             — spawn, WebSocket NDJSON, resume
      codex.ts              — spawn, stdio JSON-RPC, resume
    normalize/
      types.ts              — NormalizedEvent union
      claude.ts             — raw Claude → NormalizedEvent
      codex.ts              — raw Codex → NormalizedEvent
  cli/
    index.ts                — start + resume commands
  test/
    types.test.ts
    bridge.test.ts
    client.test.ts
    adapters/
      claude.test.ts
      codex.test.ts
    normalize/
      claude.test.ts
      codex.test.ts
```

---

## Task 1: Project scaffold

**Files:**

- Create: `packages/coding-agents/package.json`
- Create: `packages/coding-agents/tsdown.config.ts`
- Create: `packages/coding-agents/tsconfig.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@durable-streams/coding-agents",
  "description": "Bridge coding agents to durable streams for persistent, shareable sessions",
  "version": "0.1.0",
  "author": "Durable Stream contributors",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/durable-streams/durable-streams.git",
    "directory": "packages/coding-agents"
  },
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./client": {
      "import": {
        "types": "./dist/client.d.ts",
        "default": "./dist/client.js"
      },
      "require": {
        "types": "./dist/client.d.cts",
        "default": "./dist/client.cjs"
      }
    },
    "./package.json": "./package.json"
  },
  "bin": {
    "coding-agents": "./dist/cli/index.js"
  },
  "sideEffects": false,
  "files": ["dist", "src"],
  "dependencies": {
    "@durable-streams/client": "workspace:*",
    "ws": "^8.0.0"
  },
  "devDependencies": {
    "@durable-streams/server": "workspace:*",
    "@types/ws": "^8.0.0",
    "tsdown": "^0.9.0"
  },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Create `tsdown.config.ts`**

```typescript
import type { Options } from "tsdown"

const config: Options = {
  entry: ["src/index.ts", "src/client.ts", "cli/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
}

export default config
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*", "cli/**/*", "test/**/*", "*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Add vitest project**

Add the alias to the `alias` object in `vitest.config.ts`:

```typescript
"@durable-streams/coding-agents": path.resolve(
  __dirname,
  "./packages/coding-agents/src"
),
```

Add the project to the `projects` array:

```typescript
defineProject({
  test: {
    name: "coding-agents",
    include: ["packages/coding-agents/test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
  resolve: { alias },
}),
```

- [ ] **Step 5: Create placeholder source files and install**

Create empty files at every path listed in the file structure above (all `src/`, `cli/`, and `test/` files). Each file should export an empty object or contain a single comment:

```typescript
// placeholder
export {}
```

Then run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm install
```

Expected: clean install.

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agents/ vitest.config.ts pnpm-lock.yaml
git commit -m "feat(coding-agents): scaffold package"
```

---

## Task 2: Shared types

**Files:**

- Create: `packages/coding-agents/src/types.ts`
- Create: `packages/coding-agents/src/adapters/types.ts`
- Create: `packages/coding-agents/test/types.test.ts`

- [ ] **Step 1: Write the failing test**

`test/types.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import type {
  AgentEnvelope,
  UserEnvelope,
  BridgeEnvelope,
  StreamEnvelope,
} from "../src/types.js"

describe(`StreamEnvelope`, () => {
  it(`should accept a valid agent envelope`, () => {
    const envelope: AgentEnvelope = {
      agent: `claude`,
      direction: `agent`,
      timestamp: Date.now(),
      raw: { type: `assistant`, message: { content: [] } },
    }
    expect(envelope.direction).toBe(`agent`)
    expect(envelope.agent).toBe(`claude`)
  })

  it(`should accept a valid user envelope`, () => {
    const envelope: UserEnvelope = {
      agent: `claude`,
      direction: `user`,
      timestamp: Date.now(),
      user: { name: `Kyle`, email: `kyle@example.com` },
      raw: { type: `user_message`, text: `hello` },
    }
    expect(envelope.direction).toBe(`user`)
    expect(envelope.user.name).toBe(`Kyle`)
  })

  it(`should accept a valid bridge envelope`, () => {
    const envelope: BridgeEnvelope = {
      agent: `claude`,
      direction: `bridge`,
      timestamp: Date.now(),
      type: `session_started`,
    }
    expect(envelope.direction).toBe(`bridge`)
    expect(envelope.type).toBe(`session_started`)
  })

  it(`should discriminate envelope types via direction field`, () => {
    const envelope: StreamEnvelope = {
      agent: `codex`,
      direction: `agent`,
      timestamp: Date.now(),
      raw: { jsonrpc: `2.0`, method: `test` },
    }
    if (envelope.direction === `agent`) {
      expect(envelope.raw).toBeDefined()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: FAIL — types not exported.

- [ ] **Step 3: Implement `src/types.ts`**

```typescript
/**
 * Shared types for @durable-streams/coding-agents
 */

// ============================================================================
// Agent identity
// ============================================================================

export type AgentType = "claude" | "codex"

// ============================================================================
// User identity
// ============================================================================

export interface User {
  name: string
  email: string
}

// ============================================================================
// Stream envelopes
// ============================================================================

export interface AgentEnvelope {
  agent: AgentType
  direction: "agent"
  timestamp: number
  raw: object
}

export interface UserEnvelope {
  agent: AgentType
  direction: "user"
  timestamp: number
  user: User
  raw: object
}

export type BridgeEventType =
  | "session_started"
  | "session_resumed"
  | "session_ended"

export interface BridgeEnvelope {
  agent: AgentType
  direction: "bridge"
  timestamp: number
  type: BridgeEventType
}

export type StreamEnvelope = AgentEnvelope | UserEnvelope | BridgeEnvelope

// ============================================================================
// Session options
// ============================================================================

export interface SessionOptions {
  agent: AgentType
  streamUrl: string
  cwd: string
  model?: string
  permissionMode?: string
  verbose?: boolean
  resume?: boolean
  rewritePaths?: Record<string, string>
}

export interface Session {
  sessionId: string
  streamUrl: string
  close(): Promise<void>
}

// ============================================================================
// Client options
// ============================================================================

export interface ClientOptions {
  agent: AgentType
  streamUrl: string
  user: User
  contentType?: string
}

export interface StreamClient {
  prompt(text: string): void
  respond(requestId: string | number, result: unknown): void
  cancel(): void
  events(): AsyncIterable<StreamEnvelope>
  close(): Promise<void>
}
```

- [ ] **Step 4: Implement `src/adapters/types.ts`**

```typescript
/**
 * Agent adapter interface.
 *
 * Each agent (Claude, Codex) implements this interface. The bridge
 * interacts with agents only through this contract.
 */

import type { AgentType, StreamEnvelope } from "../types.js"

// ============================================================================
// Spawn options
// ============================================================================

export interface SpawnOptions {
  cwd: string
  model?: string
  permissionMode?: string
  verbose?: boolean
  resume?: string
  env?: Record<string, string>
}

// ============================================================================
// Agent connection
// ============================================================================

export interface AgentConnection {
  onMessage(handler: (raw: object) => void): void
  send(raw: object): void
  kill(): void
  on(event: "exit", handler: (code: number | null) => void): void
}

// ============================================================================
// Message classification
// ============================================================================

export interface MessageClassification {
  type: "request" | "response" | "notification"
  id?: string | number
}

// ============================================================================
// Resume options
// ============================================================================

export interface ResumeOptions {
  cwd: string
  rewritePaths?: Record<string, string>
}

// ============================================================================
// Adapter interface
// ============================================================================

export interface AgentAdapter {
  readonly agentType: AgentType

  spawn(options: SpawnOptions): Promise<AgentConnection>

  parseDirection(raw: object): MessageClassification

  isTurnComplete(raw: object): boolean

  translateClientIntent(raw: object): object

  prepareResume(
    history: StreamEnvelope[],
    options: ResumeOptions
  ): Promise<{ resumeId: string }>
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agents/src/types.ts packages/coding-agents/src/adapters/types.ts packages/coding-agents/test/types.test.ts
git commit -m "feat(coding-agents): add shared types and adapter interface"
```

---

## Task 3: Normalized event types

**Files:**

- Create: `packages/coding-agents/src/normalize/types.ts`

- [ ] **Step 1: Write normalized event types**

```typescript
/**
 * Unified normalized event types.
 *
 * These represent a projection over raw agent protocol messages.
 * Normalizers in claude.ts and codex.ts map raw events to these types.
 */

// ============================================================================
// Content types
// ============================================================================

export interface TextContent {
  type: "text"
  text: string
}

export interface ToolUseContent {
  type: "tool_use"
  id: string
  name: string
  input: object
}

export interface ToolResultContent {
  type: "tool_result"
  toolUseId: string
  output: string
  isError?: boolean
}

export interface ThinkingContent {
  type: "thinking"
  text: string
}

// ============================================================================
// Normalized events
// ============================================================================

export interface AssistantMessageEvent {
  type: "assistant_message"
  content: Array<TextContent | ToolUseContent | ThinkingContent>
}

export interface StreamDeltaEvent {
  type: "stream_delta"
  delta: {
    kind: "text" | "thinking" | "tool_input"
    text: string
  }
}

export interface ToolCallEvent {
  type: "tool_call"
  id: string
  tool: string
  input: object
}

export interface ToolResultEvent {
  type: "tool_result"
  toolCallId: string
  output: string
  isError?: boolean
}

export interface PermissionRequestEvent {
  type: "permission_request"
  id: string | number
  tool: string
  input: object
}

export interface TurnCompleteEvent {
  type: "turn_complete"
  success: boolean
  cost?: {
    inputTokens?: number
    outputTokens?: number
    totalCost?: number
  }
}

export interface ToolProgressEvent {
  type: "tool_progress"
  toolUseId: string
  elapsed: number
}

export interface SessionInitEvent {
  type: "session_init"
  sessionId?: string
  model?: string
  permissionMode?: string
}

export interface StatusChangeEvent {
  type: "status_change"
  status: string
}

export interface UnknownEvent {
  type: "unknown"
  rawType: string
  raw: object
}

export type NormalizedEvent =
  | AssistantMessageEvent
  | StreamDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | TurnCompleteEvent
  | ToolProgressEvent
  | SessionInitEvent
  | StatusChangeEvent
  | UnknownEvent
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/coding-agents typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agents/src/normalize/types.ts
git commit -m "feat(coding-agents): add normalized event types"
```

---

## Task 4: Claude normalizer with tests

**Files:**

- Create: `packages/coding-agents/src/normalize/claude.ts`
- Create: `packages/coding-agents/test/normalize/claude.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/normalize/claude.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { normalizeClaude } from "../../src/normalize/claude.js"

describe(`normalizeClaude`, () => {
  it(`should normalize a system init message`, () => {
    const raw = {
      type: `system`,
      subtype: `init`,
      session_id: `sess-123`,
      model: `claude-sonnet-4-5-20250514`,
      tools: [],
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `session_init`,
      sessionId: `sess-123`,
      model: `claude-sonnet-4-5-20250514`,
    })
  })

  it(`should normalize an assistant message`, () => {
    const raw = {
      type: `assistant`,
      message: {
        content: [{ type: `text`, text: `Hello world` }],
      },
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `assistant_message`,
      content: [{ type: `text`, text: `Hello world` }],
    })
  })

  it(`should normalize a stream_event text delta`, () => {
    const raw = {
      type: `stream_event`,
      event: {
        type: `content_block_delta`,
        delta: { type: `text_delta`, text: `Hello` },
      },
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `stream_delta`,
      delta: { kind: `text`, text: `Hello` },
    })
  })

  it(`should normalize a stream_event thinking delta`, () => {
    const raw = {
      type: `stream_event`,
      event: {
        type: `content_block_delta`,
        delta: { type: `thinking_delta`, thinking: `Let me think...` },
      },
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `stream_delta`,
      delta: { kind: `thinking`, text: `Let me think...` },
    })
  })

  it(`should normalize a permission request (can_use_tool)`, () => {
    const raw = {
      type: `control_request`,
      request_id: `req-42`,
      request: {
        subtype: `can_use_tool`,
        tool_name: `Bash`,
        input: { command: `npm install` },
        tool_use_id: `tool-1`,
      },
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `permission_request`,
      id: `req-42`,
      tool: `Bash`,
      input: { command: `npm install` },
    })
  })

  it(`should normalize a success result`, () => {
    const raw = {
      type: `result`,
      subtype: `success`,
      cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `turn_complete`,
      success: true,
      cost: {
        inputTokens: 1000,
        outputTokens: 500,
        totalCost: 0.05,
      },
    })
  })

  it(`should normalize an error result`, () => {
    const raw = {
      type: `result`,
      subtype: `error_during_execution`,
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `turn_complete`,
      success: false,
    })
  })

  it(`should normalize a tool_progress event`, () => {
    const raw = {
      type: `tool_progress`,
      tool_use_id: `tool-1`,
      elapsed: 5000,
    }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `tool_progress`,
      toolUseId: `tool-1`,
      elapsed: 5000,
    })
  })

  it(`should return unknown for unrecognized types`, () => {
    const raw = { type: `some_future_type`, data: 123 }
    const event = normalizeClaude(raw)
    expect(event).toEqual({
      type: `unknown`,
      rawType: `some_future_type`,
      raw,
    })
  })

  it(`should skip keep_alive and user echo messages`, () => {
    expect(normalizeClaude({ type: `keep_alive` })).toBeNull()
    expect(normalizeClaude({ type: `user` })).toBeNull()
    expect(normalizeClaude({ type: `rate_limit_event` })).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: FAIL — `normalizeClaude` not exported.

- [ ] **Step 3: Implement `src/normalize/claude.ts`**

```typescript
import type { NormalizedEvent } from "./types.js"

/**
 * Messages the bridge should ignore (not forwarded to browser in Companion).
 */
const SKIP_TYPES = new Set([
  `keep_alive`,
  `user`,
  `rate_limit_event`,
  `streamlined_text`,
  `streamlined_tool_use_summary`,
])

/**
 * Normalize a raw Claude Code NDJSON message into a NormalizedEvent.
 * Returns null for messages that should be skipped.
 */
export function normalizeClaude(raw: object): NormalizedEvent | null {
  const r = raw as Record<string, unknown>
  const type = r.type as string | undefined

  if (!type || SKIP_TYPES.has(type)) return null

  switch (type) {
    case `system`: {
      return {
        type: `session_init`,
        sessionId: r.session_id as string | undefined,
        model: r.model as string | undefined,
        permissionMode: r.permission_mode as string | undefined,
      }
    }

    case `assistant`: {
      const message = r.message as Record<string, unknown> | undefined
      const content = (message?.content as Array<Record<string, unknown>>) ?? []
      return {
        type: `assistant_message`,
        content: content.map((block) => {
          const blockType = block.type as string
          if (blockType === `thinking`) {
            return { type: `thinking` as const, text: block.thinking as string }
          }
          if (blockType === `tool_use`) {
            return {
              type: `tool_use` as const,
              id: block.id as string,
              name: block.name as string,
              input: (block.input as object) ?? {},
            }
          }
          return { type: `text` as const, text: (block.text as string) ?? `` }
        }),
      }
    }

    case `stream_event`: {
      const event = r.event as Record<string, unknown> | undefined
      if (!event) return { type: `unknown`, rawType: type, raw }

      const eventType = event.type as string
      if (eventType === `content_block_delta`) {
        const delta = event.delta as Record<string, unknown>
        const deltaType = delta?.type as string
        if (deltaType === `text_delta`) {
          return {
            type: `stream_delta`,
            delta: { kind: `text`, text: delta.text as string },
          }
        }
        if (deltaType === `thinking_delta`) {
          return {
            type: `stream_delta`,
            delta: { kind: `thinking`, text: delta.thinking as string },
          }
        }
        if (deltaType === `input_json_delta`) {
          return {
            type: `stream_delta`,
            delta: { kind: `tool_input`, text: delta.partial_json as string },
          }
        }
      }
      return null
    }

    case `control_request`: {
      const request = r.request as Record<string, unknown> | undefined
      if (request?.subtype === `can_use_tool`) {
        return {
          type: `permission_request`,
          id: r.request_id as string,
          tool: request.tool_name as string,
          input: (request.input as object) ?? {},
        }
      }
      return {
        type: `unknown`,
        rawType: `control_request:${request?.subtype}`,
        raw,
      }
    }

    case `result`: {
      const subtype = r.subtype as string
      const usage = r.usage as Record<string, number> | undefined
      const result: NormalizedEvent = {
        type: `turn_complete`,
        success: subtype === `success`,
      }
      if (usage || r.cost_usd != null) {
        result.cost = {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          totalCost: r.cost_usd as number | undefined,
        }
      }
      return result
    }

    case `tool_progress`: {
      return {
        type: `tool_progress`,
        toolUseId: r.tool_use_id as string,
        elapsed: r.elapsed as number,
      }
    }

    default:
      return { type: `unknown`, rawType: type, raw }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agents/src/normalize/claude.ts packages/coding-agents/test/normalize/claude.test.ts
git commit -m "feat(coding-agents): add Claude normalizer"
```

---

## Task 5: Codex normalizer with tests

**Files:**

- Create: `packages/coding-agents/src/normalize/codex.ts`
- Create: `packages/coding-agents/test/normalize/codex.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/normalize/codex.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { normalizeCodex } from "../../src/normalize/codex.js"

describe(`normalizeCodex`, () => {
  it(`should normalize an agent message`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `agentMessage`,
        content: `Here is the fix.`,
      },
    }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `assistant_message`,
      content: [{ type: `text`, text: `Here is the fix.` }],
    })
  })

  it(`should normalize a reasoning item`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `reasoning`,
        content: `Let me think about this...`,
      },
    }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `assistant_message`,
      content: [{ type: `thinking`, text: `Let me think about this...` }],
    })
  })

  it(`should normalize a command execution`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `commandExecution`,
        command: `npm test`,
        output: `All tests passed`,
        exitCode: 0,
        id: `cmd-1`,
      },
    }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `tool_call`,
      id: `cmd-1`,
      tool: `terminal`,
      input: { command: `npm test` },
    })
  })

  it(`should normalize a file change`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `fileChange`,
        path: `src/index.ts`,
        diff: `+const x = 1`,
        id: `file-1`,
      },
    }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `tool_call`,
      id: `file-1`,
      tool: `file_edit`,
      input: { path: `src/index.ts`, diff: `+const x = 1` },
    })
  })

  it(`should normalize an approval request`, () => {
    const raw = {
      type: `approval_request`,
      id: `approval-1`,
      tool_name: `Bash`,
      tool_input: { command: `rm -rf node_modules` },
    }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `permission_request`,
      id: `approval-1`,
      tool: `Bash`,
      input: { command: `rm -rf node_modules` },
    })
  })

  it(`should normalize a turn complete (JSON-RPC response)`, () => {
    const raw = {
      jsonrpc: `2.0`,
      id: 1,
      result: { success: true },
    }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `turn_complete`,
      success: true,
    })
  })

  it(`should normalize a turn error`, () => {
    const raw = {
      jsonrpc: `2.0`,
      id: 1,
      error: { code: -32000, message: `Something failed` },
    }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `turn_complete`,
      success: false,
    })
  })

  it(`should return unknown for unrecognized types`, () => {
    const raw = { type: `future_type`, data: true }
    const event = normalizeCodex(raw)
    expect(event).toEqual({
      type: `unknown`,
      rawType: `future_type`,
      raw,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: FAIL — `normalizeCodex` not exported.

- [ ] **Step 3: Implement `src/normalize/codex.ts`**

```typescript
import type { NormalizedEvent } from "./types.js"

/**
 * Normalize a raw Codex JSON-RPC or item message into a NormalizedEvent.
 * Returns null for messages that should be skipped.
 */
export function normalizeCodex(raw: object): NormalizedEvent | null {
  const r = raw as Record<string, unknown>

  // JSON-RPC response (turn completion)
  if (r.jsonrpc === `2.0` && r.id != null && !r.method) {
    if (r.error) {
      return { type: `turn_complete`, success: false }
    }
    return { type: `turn_complete`, success: true }
  }

  // Approval request
  if (r.type === `approval_request`) {
    return {
      type: `permission_request`,
      id: r.id as string | number,
      tool: r.tool_name as string,
      input: (r.tool_input as object) ?? {},
    }
  }

  // Item-based messages
  if (r.type === `item`) {
    const item = r.item as Record<string, unknown>
    const itemType = item?.type as string

    switch (itemType) {
      case `agentMessage`:
        return {
          type: `assistant_message`,
          content: [{ type: `text`, text: item.content as string }],
        }

      case `reasoning`:
        return {
          type: `assistant_message`,
          content: [{ type: `thinking`, text: item.content as string }],
        }

      case `commandExecution`:
        return {
          type: `tool_call`,
          id: item.id as string,
          tool: `terminal`,
          input: { command: item.command as string },
        }

      case `fileChange`:
        return {
          type: `tool_call`,
          id: item.id as string,
          tool: `file_edit`,
          input: {
            path: item.path as string,
            diff: item.diff as string,
          },
        }

      case `mcpToolCall`:
        return {
          type: `tool_call`,
          id: item.id as string,
          tool: item.name as string,
          input: (item.arguments as object) ?? {},
        }

      default:
        return { type: `unknown`, rawType: `item:${itemType}`, raw }
    }
  }

  const type = r.type as string | undefined
  if (!type) return { type: `unknown`, rawType: `no_type`, raw }
  return { type: `unknown`, rawType: type, raw }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agents/src/normalize/codex.ts packages/coding-agents/test/normalize/codex.test.ts
git commit -m "feat(coding-agents): add Codex normalizer"
```

---

## Task 6: Claude adapter with tests

**Files:**

- Create: `packages/coding-agents/src/adapters/claude.ts`
- Create: `packages/coding-agents/test/adapters/claude.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/adapters/claude.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { ClaudeAdapter } from "../../src/adapters/claude.js"

describe(`ClaudeAdapter`, () => {
  const adapter = new ClaudeAdapter()

  describe(`agentType`, () => {
    it(`should be claude`, () => {
      expect(adapter.agentType).toBe(`claude`)
    })
  })

  describe(`parseDirection`, () => {
    it(`should classify a control_request as a request`, () => {
      const result = adapter.parseDirection({
        type: `control_request`,
        request_id: `req-1`,
        request: { subtype: `can_use_tool` },
      })
      expect(result).toEqual({ type: `request`, id: `req-1` })
    })

    it(`should classify a control_response as a response`, () => {
      const result = adapter.parseDirection({
        type: `control_response`,
        response: { request_id: `req-1`, subtype: `success` },
      })
      expect(result).toEqual({ type: `response`, id: `req-1` })
    })

    it(`should classify an assistant message as a notification`, () => {
      const result = adapter.parseDirection({
        type: `assistant`,
        message: { content: [] },
      })
      expect(result).toEqual({ type: `notification` })
    })

    it(`should classify a result as a notification`, () => {
      const result = adapter.parseDirection({
        type: `result`,
        subtype: `success`,
      })
      expect(result).toEqual({ type: `notification` })
    })

    it(`should classify a stream_event as a notification`, () => {
      const result = adapter.parseDirection({
        type: `stream_event`,
        event: {},
      })
      expect(result).toEqual({ type: `notification` })
    })
  })

  describe(`isTurnComplete`, () => {
    it(`should return true for result messages`, () => {
      expect(
        adapter.isTurnComplete({ type: `result`, subtype: `success` })
      ).toBe(true)
      expect(
        adapter.isTurnComplete({
          type: `result`,
          subtype: `error_during_execution`,
        })
      ).toBe(true)
    })

    it(`should return false for other messages`, () => {
      expect(adapter.isTurnComplete({ type: `assistant` })).toBe(false)
      expect(adapter.isTurnComplete({ type: `stream_event` })).toBe(false)
      expect(adapter.isTurnComplete({ type: `control_request` })).toBe(false)
    })
  })

  describe(`translateClientIntent`, () => {
    it(`should pass through raw messages unchanged`, () => {
      const raw = { type: `user_message`, text: `hello` }
      expect(adapter.translateClientIntent(raw)).toBe(raw)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: FAIL — `ClaudeAdapter` not exported.

- [ ] **Step 3: Implement `src/adapters/claude.ts`**

```typescript
import { WebSocketServer } from "ws"
import type WebSocket from "ws"
import { spawn } from "node:child_process"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
  SpawnOptions,
  ResumeOptions,
} from "./types.js"
import type { StreamEnvelope } from "../types.js"

export class ClaudeAdapter implements AgentAdapter {
  readonly agentType = `claude` as const

  async spawn(options: SpawnOptions): Promise<AgentConnection> {
    const { cwd, model, permissionMode, verbose, resume, env } = options

    // Find a free port for the WebSocket server
    const port = await findFreePort()
    const sessionId = resume ?? `session-${Date.now()}`
    const sdkUrl = `ws://127.0.0.1:${port}/ws/cli/${sessionId}`

    // Start WebSocket server and wait for agent connection
    return new Promise<AgentConnection>((resolve, reject) => {
      const wss = new WebSocketServer({ port })
      let messageHandler: ((raw: object) => void) | null = null
      let exitHandler: ((code: number | null) => void) | null = null
      let agentSocket: WebSocket | null = null

      const args = [
        `--sdk-url`,
        sdkUrl,
        `--print`,
        `--output-format`,
        `stream-json`,
        `--input-format`,
        `stream-json`,
      ]
      if (model) args.push(`--model`, model)
      if (permissionMode) args.push(`--permission-mode`, permissionMode)
      if (verbose) args.push(`--verbose`)
      if (resume) args.push(`--resume`, resume)
      args.push(`-p`, ``)

      const child = spawn(`claude`, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: [`pipe`, `pipe`, `pipe`],
      })

      child.on(`error`, (err) => {
        wss.close()
        reject(err)
      })

      child.on(`exit`, (code) => {
        exitHandler?.(code)
        wss.close()
      })

      wss.on(`connection`, (ws) => {
        agentSocket = ws
        let buffer = ``

        ws.on(`message`, (data) => {
          buffer += data.toString()
          const lines = buffer.split(`\n`)
          buffer = lines.pop()!
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const parsed = JSON.parse(trimmed) as object
              messageHandler?.(parsed)
            } catch {
              // skip unparseable lines
            }
          }
        })

        ws.on(`close`, () => {
          agentSocket = null
        })

        const connection: AgentConnection = {
          onMessage(handler) {
            messageHandler = handler
          },
          send(raw) {
            if (agentSocket?.readyState === 1) {
              agentSocket.send(JSON.stringify(raw) + `\n`)
            }
          },
          kill() {
            child.kill()
            wss.close()
          },
          on(event, handler) {
            if (event === `exit`) exitHandler = handler
          },
        }
        resolve(connection)
      })

      // Timeout if agent doesn't connect
      setTimeout(() => {
        wss.close()
        child.kill()
        reject(new Error(`Claude Code did not connect within 30s`))
      }, 30_000)
    })
  }

  parseDirection(raw: object): MessageClassification {
    const r = raw as Record<string, unknown>
    const type = r.type as string | undefined

    if (type === `control_request`) {
      return { type: `request`, id: r.request_id as string }
    }

    if (type === `control_response`) {
      const response = r.response as Record<string, unknown> | undefined
      return { type: `response`, id: response?.request_id as string }
    }

    return { type: `notification` }
  }

  isTurnComplete(raw: object): boolean {
    const r = raw as Record<string, unknown>
    return r.type === `result`
  }

  translateClientIntent(raw: object): object {
    return raw
  }

  async prepareResume(
    history: StreamEnvelope[],
    options: ResumeOptions
  ): Promise<{ resumeId: string }> {
    const fs = await import(`node:fs/promises`)
    const path = await import(`node:path`)
    const os = await import(`node:os`)

    // Extract the Claude session ID from the first system/init message
    let claudeSessionId: string | undefined
    for (const envelope of history) {
      if (envelope.direction === `agent`) {
        const r = envelope.raw as Record<string, unknown>
        if (r.type === `system` && r.subtype === `init`) {
          claudeSessionId = r.session_id as string
          break
        }
      }
    }

    if (!claudeSessionId) {
      claudeSessionId = `resume-${Date.now()}`
    }

    // Reconstruct JSONL session file with reconciliation
    const projectDir = path.join(
      os.homedir(),
      `.claude`,
      `projects`,
      `_resumed`
    )
    await fs.mkdir(projectDir, { recursive: true })

    const sessionFile = path.join(projectDir, `${claudeSessionId}.jsonl`)
    const lines: string[] = []

    // Dedup: track which request IDs have already been responded to
    const respondedRequestIds = new Set<string | number>()

    for (const envelope of history) {
      if (envelope.direction === `bridge`) continue

      if (envelope.direction === `user`) {
        const raw = envelope.raw as Record<string, unknown>
        // Dedup permission responses: only include the first per request ID
        if (raw.type === `control_response`) {
          const response = raw.response as Record<string, unknown>
          const requestId = response?.request_id as string | number
          if (respondedRequestIds.has(requestId)) continue
          respondedRequestIds.add(requestId)
        }
      }

      let rawStr = JSON.stringify(envelope.raw)

      if (options.rewritePaths) {
        for (const [from, to] of Object.entries(options.rewritePaths)) {
          rawStr = rawStr.replaceAll(from, to)
        }
      }

      lines.push(rawStr)
    }

    await fs.writeFile(sessionFile, lines.join(`\n`) + `\n`, `utf-8`)
    return { resumeId: claudeSessionId }
  }
}

async function findFreePort(): Promise<number> {
  const net = await import(`node:net`)
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (typeof addr === `object` && addr) {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error(`Could not get port`))
      }
    })
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agents/src/adapters/claude.ts packages/coding-agents/test/adapters/claude.test.ts
git commit -m "feat(coding-agents): add Claude adapter"
```

---

## Task 7: Codex adapter with tests

**Files:**

- Create: `packages/coding-agents/src/adapters/codex.ts`
- Create: `packages/coding-agents/test/adapters/codex.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/adapters/codex.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { CodexAdapter } from "../../src/adapters/codex.js"

describe(`CodexAdapter`, () => {
  const adapter = new CodexAdapter()

  describe(`agentType`, () => {
    it(`should be codex`, () => {
      expect(adapter.agentType).toBe(`codex`)
    })
  })

  describe(`parseDirection`, () => {
    it(`should classify a JSON-RPC request (with method) as a request`, () => {
      const result = adapter.parseDirection({
        jsonrpc: `2.0`,
        id: 1,
        method: `approval/request`,
        params: {},
      })
      expect(result).toEqual({ type: `request`, id: 1 })
    })

    it(`should classify a JSON-RPC response (with result) as a response`, () => {
      const result = adapter.parseDirection({
        jsonrpc: `2.0`,
        id: 1,
        result: { success: true },
      })
      expect(result).toEqual({ type: `response`, id: 1 })
    })

    it(`should classify a JSON-RPC error as a response`, () => {
      const result = adapter.parseDirection({
        jsonrpc: `2.0`,
        id: 1,
        error: { code: -1, message: `fail` },
      })
      expect(result).toEqual({ type: `response`, id: 1 })
    })

    it(`should classify a JSON-RPC notification (no id) as a notification`, () => {
      const result = adapter.parseDirection({
        jsonrpc: `2.0`,
        method: `session/update`,
        params: {},
      })
      expect(result).toEqual({ type: `notification` })
    })

    it(`should classify an item message as a notification`, () => {
      const result = adapter.parseDirection({
        type: `item`,
        item: { type: `agentMessage` },
      })
      expect(result).toEqual({ type: `notification` })
    })

    it(`should classify an approval_request as a request`, () => {
      const result = adapter.parseDirection({
        type: `approval_request`,
        id: `apr-1`,
      })
      expect(result).toEqual({ type: `request`, id: `apr-1` })
    })
  })

  describe(`isTurnComplete`, () => {
    it(`should return true for a JSON-RPC response with result`, () => {
      expect(
        adapter.isTurnComplete({ jsonrpc: `2.0`, id: 1, result: {} })
      ).toBe(true)
    })

    it(`should return true for a JSON-RPC error response`, () => {
      expect(
        adapter.isTurnComplete({
          jsonrpc: `2.0`,
          id: 1,
          error: { code: -1, message: `fail` },
        })
      ).toBe(true)
    })

    it(`should return false for notifications`, () => {
      expect(adapter.isTurnComplete({ jsonrpc: `2.0`, method: `update` })).toBe(
        false
      )
    })

    it(`should return false for item messages`, () => {
      expect(adapter.isTurnComplete({ type: `item`, item: {} })).toBe(false)
    })
  })

  describe(`translateClientIntent`, () => {
    it(`should translate a user_message to JSON-RPC`, () => {
      const result = adapter.translateClientIntent({
        type: `user_message`,
        text: `Fix the bug`,
      })
      expect(result).toEqual({
        jsonrpc: `2.0`,
        method: `codex/prompt`,
        params: { text: `Fix the bug` },
      })
    })

    it(`should translate a control_response to JSON-RPC response`, () => {
      const result = adapter.translateClientIntent({
        type: `control_response`,
        response: {
          request_id: 42,
          subtype: `success`,
          response: { behavior: `allow` },
        },
      })
      expect(result).toEqual({
        jsonrpc: `2.0`,
        id: 42,
        result: { behavior: `allow` },
      })
    })

    it(`should translate an interrupt to JSON-RPC cancel`, () => {
      const result = adapter.translateClientIntent({ type: `interrupt` })
      expect(result).toEqual({
        jsonrpc: `2.0`,
        method: `codex/cancel`,
      })
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: FAIL — `CodexAdapter` not exported.

- [ ] **Step 3: Implement `src/adapters/codex.ts`**

```typescript
import { spawn } from "node:child_process"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
  SpawnOptions,
  ResumeOptions,
} from "./types.js"
import type { StreamEnvelope } from "../types.js"

export class CodexAdapter implements AgentAdapter {
  readonly agentType = `codex` as const

  async spawn(options: SpawnOptions): Promise<AgentConnection> {
    const { cwd, model, permissionMode, env } = options

    const args: string[] = []
    if (model) args.push(`--model`, model)

    // Map permission modes to Codex policy
    if (permissionMode === `auto`) {
      args.push(`--approval-policy`, `auto`)
    } else if (permissionMode === `plan`) {
      args.push(`--approval-policy`, `never`)
    }

    const child = spawn(`codex`, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [`pipe`, `pipe`, `pipe`],
    })

    let messageHandler: ((raw: object) => void) | null = null
    let exitHandler: ((code: number | null) => void) | null = null
    let buffer = ``

    child.stdout!.on(`data`, (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split(`\n`)
      buffer = lines.pop()!
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as object
          messageHandler?.(parsed)
        } catch {
          // skip unparseable lines
        }
      }
    })

    child.on(`error`, (err) => {
      throw err
    })

    child.on(`exit`, (code) => {
      exitHandler?.(code)
    })

    return {
      onMessage(handler) {
        messageHandler = handler
      },
      send(raw) {
        if (child.stdin!.writable) {
          child.stdin!.write(JSON.stringify(raw) + `\n`)
        }
      },
      kill() {
        child.kill()
      },
      on(event, handler) {
        if (event === `exit`) exitHandler = handler
      },
    }
  }

  parseDirection(raw: object): MessageClassification {
    const r = raw as Record<string, unknown>

    // Approval requests
    if (r.type === `approval_request`) {
      return { type: `request`, id: r.id as string | number }
    }

    // JSON-RPC messages
    if (r.jsonrpc === `2.0`) {
      const hasMethod = `method` in r
      const hasId = r.id != null

      if (hasMethod && hasId) {
        return { type: `request`, id: r.id as number }
      }
      if (!hasMethod && hasId) {
        return { type: `response`, id: r.id as number }
      }
      return { type: `notification` }
    }

    return { type: `notification` }
  }

  isTurnComplete(raw: object): boolean {
    const r = raw as Record<string, unknown>
    // A JSON-RPC response (has id, no method, has result or error)
    return (
      r.jsonrpc === `2.0` &&
      r.id != null &&
      !(`method` in r) &&
      (`result` in r || `error` in r)
    )
  }

  translateClientIntent(raw: object): object {
    const r = raw as Record<string, unknown>
    const type = r.type as string

    if (type === `user_message`) {
      return {
        jsonrpc: `2.0`,
        method: `codex/prompt`,
        params: { text: r.text },
      }
    }

    if (type === `control_response`) {
      const response = r.response as Record<string, unknown>
      return {
        jsonrpc: `2.0`,
        id: response.request_id,
        result: response.response,
      }
    }

    if (type === `interrupt`) {
      return {
        jsonrpc: `2.0`,
        method: `codex/cancel`,
      }
    }

    return raw
  }

  async prepareResume(
    history: StreamEnvelope[],
    options: ResumeOptions
  ): Promise<{ resumeId: string }> {
    const fs = await import(`node:fs/promises`)
    const path = await import(`node:path`)
    const os = await import(`node:os`)

    const resumeId = `codex-resume-${Date.now()}`
    const resumeDir = path.join(os.homedir(), `.codex`, `sessions`)
    await fs.mkdir(resumeDir, { recursive: true })

    const sessionFile = path.join(resumeDir, `${resumeId}.jsonl`)
    const lines: string[] = []

    // Dedup: track which request IDs have already been responded to
    const respondedRequestIds = new Set<string | number>()

    for (const envelope of history) {
      if (envelope.direction === `bridge`) continue

      // For user envelopes, translate generic intent to native Codex JSON-RPC
      let raw = envelope.raw
      if (envelope.direction === `user`) {
        const r = raw as Record<string, unknown>
        if (r.type === `control_response`) {
          const response = r.response as Record<string, unknown>
          const requestId = response?.request_id as string | number
          if (respondedRequestIds.has(requestId)) continue
          respondedRequestIds.add(requestId)
        }
        raw = this.translateClientIntent(raw)
      }

      let rawStr = JSON.stringify(raw)

      if (options.rewritePaths) {
        for (const [from, to] of Object.entries(options.rewritePaths)) {
          rawStr = rawStr.replaceAll(from, to)
        }
      }

      lines.push(rawStr)
    }

    await fs.writeFile(sessionFile, lines.join(`\n`) + `\n`, `utf-8`)
    return { resumeId }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agents/src/adapters/codex.ts packages/coding-agents/test/adapters/codex.test.ts
git commit -m "feat(coding-agents): add Codex adapter"
```

---

## Task 8: Bridge with tests

**Files:**

- Create: `packages/coding-agents/src/bridge.ts`
- Create: `packages/coding-agents/test/bridge.test.ts`

This is the core relay module. Tests use a mock adapter (no real agent process) and the test stream server.

- [ ] **Step 1: Write the failing tests**

`test/bridge.test.ts`:

```typescript
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream, IdempotentProducer } from "@durable-streams/client"
import { startBridge } from "../src/bridge.js"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
} from "../src/adapters/types.js"
import type {
  StreamEnvelope,
  AgentEnvelope,
  BridgeEnvelope,
} from "../src/types.js"

// Mock adapter that captures sent messages and lets us simulate agent output
function createMockAdapter(): {
  adapter: AgentAdapter
  connection: {
    simulateMessage: (raw: object) => void
    sentMessages: object[]
    killed: boolean
  }
} {
  let messageHandler: ((raw: object) => void) | null = null
  let exitHandler: ((code: number | null) => void) | null = null
  const sentMessages: object[] = []
  let killed = false

  const mockConnection: AgentConnection = {
    onMessage(handler) {
      messageHandler = handler
    },
    send(raw) {
      sentMessages.push(raw)
    },
    kill() {
      killed = true
    },
    on(event, handler) {
      if (event === `exit`) exitHandler = handler
    },
  }

  const adapter: AgentAdapter = {
    agentType: `claude`,
    async spawn() {
      return mockConnection
    },
    parseDirection(raw: object): MessageClassification {
      const r = raw as Record<string, unknown>
      if (r.type === `control_request`)
        return { type: `request`, id: r.request_id as string }
      if (r.type === `control_response`)
        return {
          type: `response`,
          id: (r.response as Record<string, unknown>)?.request_id as string,
        }
      return { type: `notification` }
    },
    isTurnComplete(raw: object) {
      return (raw as Record<string, unknown>).type === `result`
    },
    translateClientIntent(raw: object) {
      return raw
    },
    async prepareResume() {
      return { resumeId: `mock-resume` }
    },
  }

  return {
    adapter,
    connection: {
      simulateMessage: (raw: object) => messageHandler?.(raw),
      sentMessages,
      get killed() {
        return killed
      },
    },
  }
}

describe(`startBridge`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  it(`should write agent messages to the stream`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-test-${Date.now()}`
    const { adapter, connection } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
      contentType: `application/json`,
    })

    // Simulate agent sending a message
    connection.simulateMessage({ type: `assistant`, message: { content: [] } })

    // Wait for the producer to flush
    await new Promise((r) => setTimeout(r, 100))

    // Read from stream
    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<AgentEnvelope>({ json: true })
    const items = await response.json()

    // Should have session_started + the assistant message
    const agentMessages = items.filter(
      (i) => (i as StreamEnvelope).direction === `agent`
    )
    expect(agentMessages.length).toBe(1)
    expect(agentMessages[0]!.raw).toEqual({
      type: `assistant`,
      message: { content: [] },
    })

    await session.close()
  })

  it(`should forward user prompts from the stream to the agent`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-prompt-${Date.now()}`
    const { adapter, connection } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
      contentType: `application/json`,
    })

    // Write a user prompt to the stream
    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const clientProducer = new IdempotentProducer(clientStream, `test-client`, {
      autoClaim: true,
    })
    const userEnvelope = {
      agent: `claude`,
      direction: `user`,
      timestamp: Date.now(),
      user: { name: `Test`, email: `test@test.com` },
      raw: { type: `user_message`, text: `Hello` },
    }
    clientProducer.append(JSON.stringify(userEnvelope))
    await clientProducer.flush()

    // Wait for bridge to process
    await new Promise((r) => setTimeout(r, 200))

    // Bridge should have forwarded to agent
    expect(connection.sentMessages.length).toBeGreaterThanOrEqual(1)
    const forwarded = connection.sentMessages.find(
      (m) => (m as Record<string, unknown>).type === `user_message`
    )
    expect(forwarded).toBeDefined()

    await session.close()
    await clientProducer.close()
  })

  it(`should drop duplicate responses for the same request ID`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-dedup-${Date.now()}`
    const { adapter, connection } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
      contentType: `application/json`,
    })

    // Simulate agent sending a permission request
    connection.simulateMessage({
      type: `control_request`,
      request_id: `perm-1`,
      request: { subtype: `can_use_tool`, tool_name: `Bash` },
    })
    await new Promise((r) => setTimeout(r, 100))

    // Two clients respond to the same request
    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const producer = new IdempotentProducer(clientStream, `test-dedup`, {
      autoClaim: true,
    })

    const response1 = {
      agent: `claude`,
      direction: `user`,
      timestamp: Date.now(),
      user: { name: `Alice`, email: `alice@test.com` },
      raw: {
        type: `control_response`,
        response: {
          request_id: `perm-1`,
          subtype: `success`,
          response: { behavior: `allow`, updatedInput: {} },
        },
      },
    }
    const response2 = {
      agent: `claude`,
      direction: `user`,
      timestamp: Date.now() + 1,
      user: { name: `Bob`, email: `bob@test.com` },
      raw: {
        type: `control_response`,
        response: {
          request_id: `perm-1`,
          subtype: `success`,
          response: { behavior: `deny`, updatedInput: {} },
        },
      },
    }

    producer.append(JSON.stringify(response1))
    producer.append(JSON.stringify(response2))
    await producer.flush()

    await new Promise((r) => setTimeout(r, 300))

    // Only the first response should have been forwarded
    const controlResponses = connection.sentMessages.filter(
      (m) => (m as Record<string, unknown>).type === `control_response`
    )
    expect(controlResponses.length).toBe(1)

    await session.close()
    await producer.close()
  })

  it(`should write session_started on startup`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-start-${Date.now()}`
    const { adapter } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
      contentType: `application/json`,
    })

    await new Promise((r) => setTimeout(r, 100))

    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<StreamEnvelope>({ json: true })
    const items = await response.json()

    const bridgeEvents = items.filter(
      (i) => (i as StreamEnvelope).direction === `bridge`
    ) as BridgeEnvelope[]
    expect(bridgeEvents[0]!.type).toBe(`session_started`)

    await session.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: FAIL — `startBridge` not exported.

- [ ] **Step 3: Implement `src/bridge.ts`**

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"
import type {
  AgentEnvelope,
  UserEnvelope,
  BridgeEnvelope,
  StreamEnvelope,
  Session,
} from "./types.js"
import type { AgentAdapter, AgentConnection } from "./adapters/types.js"

export interface BridgeOptions {
  adapter: AgentAdapter
  streamUrl: string
  cwd: string
  contentType?: string
  model?: string
  permissionMode?: string
  verbose?: boolean
  rewritePaths?: Record<string, string>
}

export async function startBridge(options: BridgeOptions): Promise<Session> {
  const {
    adapter,
    streamUrl,
    cwd,
    contentType = `application/json`,
    model,
    permissionMode,
    verbose,
    rewritePaths,
  } = options

  // Connect to or create stream
  let stream: DurableStream
  try {
    stream = await DurableStream.create({ url: streamUrl, contentType })
  } catch (e: unknown) {
    const err = e as { status?: number }
    if (err.status === 409) {
      stream = new DurableStream({ url: streamUrl, contentType })
    } else {
      throw e
    }
  }

  // Read existing history
  const historyResponse = await stream.stream<StreamEnvelope>({ json: true })
  const history = await historyResponse.json()
  const resumeOffset = historyResponse.offset

  const isResume = history.length > 0

  // Derive a stable session ID from the stream URL path for producer fencing
  const streamSlug = new URL(streamUrl).pathname.split(`/`).pop() ?? `default`
  const sessionId = streamSlug
  const producer = new IdempotentProducer(stream, `bridge-${sessionId}`, {
    autoClaim: true,
  })

  // Prepare resume if history exists
  let resumeId: string | undefined
  if (isResume) {
    const result = await adapter.prepareResume(history, { cwd, rewritePaths })
    resumeId = result.resumeId
  }

  // Spawn agent
  const connection = await adapter.spawn({
    cwd,
    model,
    permissionMode,
    verbose,
    resume: resumeId,
  })

  // State
  const pendingAgentRequestIds = new Set<string | number>()
  let turnInProgress = false
  const promptQueue: object[] = []

  function processQueue(): void {
    if (turnInProgress || promptQueue.length === 0) return
    turnInProgress = true
    const prompt = promptQueue.shift()!
    connection.send(prompt)
  }

  // Forward agent messages → stream
  connection.onMessage((raw) => {
    const envelope: AgentEnvelope = {
      agent: adapter.agentType,
      direction: `agent`,
      timestamp: Date.now(),
      raw,
    }
    producer.append(JSON.stringify(envelope))

    // Track pending requests
    const classification = adapter.parseDirection(raw)
    if (classification.type === `request` && classification.id != null) {
      pendingAgentRequestIds.add(classification.id)
    }

    // Check turn completion
    if (adapter.isTurnComplete(raw)) {
      turnInProgress = false
      processQueue()
    }
  })

  // Write session_ended if agent exits or crashes
  connection.on(`exit`, () => {
    const endEvent: BridgeEnvelope = {
      agent: adapter.agentType,
      direction: `bridge`,
      timestamp: Date.now(),
      type: `session_ended`,
    }
    producer.append(JSON.stringify(endEvent))
  })

  // Write session control event
  const controlEvent: BridgeEnvelope = {
    agent: adapter.agentType,
    direction: `bridge`,
    timestamp: Date.now(),
    type: isResume ? `session_resumed` : `session_started`,
  }
  producer.append(JSON.stringify(controlEvent))

  // Live-tail stream for client messages
  const abortController = new AbortController()
  const liveStream = await stream.stream<StreamEnvelope>({
    offset: resumeOffset,
    live: `sse`,
    json: true,
    signal: abortController.signal,
  })

  void (async () => {
    try {
      for await (const item of liveStream.jsonStream()) {
        const envelope = item as StreamEnvelope
        if (envelope.direction !== `user` || !(`raw` in envelope)) continue

        const userEnvelope = envelope as UserEnvelope
        const raw = userEnvelope.raw as Record<string, unknown>

        // Handle cancel: resolve pending permission requests directly
        // to the agent, record them on the stream for resume, then send
        // the cancel signal. Do NOT call processQueue() — the agent will
        // emit a turn-complete after processing the cancel, which triggers
        // the next prompt through the normal onMessage path.
        if (raw.type === `interrupt`) {
          for (const pendingId of pendingAgentRequestIds) {
            const cancelRaw = {
              type: `control_response`,
              response: {
                request_id: pendingId,
                subtype: `cancelled`,
                response: {},
              },
            }
            // Enqueue on stream before direct send for best-effort resume fidelity
            const cancelEnvelope: UserEnvelope = {
              agent: adapter.agentType,
              direction: `user`,
              timestamp: Date.now(),
              user: userEnvelope.user,
              raw: cancelRaw,
            }
            producer.append(JSON.stringify(cancelEnvelope))
            // Then send to agent directly (bridge-synthesized, not relay)
            connection.send(adapter.translateClientIntent(cancelRaw))
          }
          pendingAgentRequestIds.clear()
          // Send cancel to agent to stop the running turn
          connection.send(adapter.translateClientIntent(raw))
          continue
        }

        // Classify the user message
        const classification = adapter.parseDirection(raw)

        if (classification.type === `notification`) {
          // Treat as a prompt — queue it (translated to native format)
          promptQueue.push(adapter.translateClientIntent(raw))
          processQueue()
        } else if (
          classification.type === `response` &&
          classification.id != null
        ) {
          // Only forward the first response per request ID
          if (!pendingAgentRequestIds.has(classification.id)) continue
          pendingAgentRequestIds.delete(classification.id)
          connection.send(adapter.translateClientIntent(raw))
        }
      }
    } catch (e: unknown) {
      const err = e as { name?: string }
      if (err.name !== `AbortError`) {
        console.error(`Stream relay error:`, e)
      }
    }
  })()

  return {
    sessionId,
    streamUrl,
    async close() {
      abortController.abort()

      const endEvent: BridgeEnvelope = {
        agent: adapter.agentType,
        direction: `bridge`,
        timestamp: Date.now(),
        type: `session_ended`,
      }
      producer.append(JSON.stringify(endEvent))
      await producer.flush()
      await producer.detach()

      connection.kill()
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agents/src/bridge.ts packages/coding-agents/test/bridge.test.ts
git commit -m "feat(coding-agents): add bridge relay"
```

---

## Task 9: Client with tests

**Files:**

- Create: `packages/coding-agents/src/client.ts`
- Create: `packages/coding-agents/test/client.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/client.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest"

const mockAppend = vi.fn()
const mockFlush = vi.fn().mockResolvedValue(undefined)
const mockDetach = vi.fn().mockResolvedValue(undefined)

vi.mock(`@durable-streams/client`, () => ({
  DurableStream: vi.fn().mockImplementation(() => ({
    stream: vi.fn().mockResolvedValue({
      jsonStream: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }),
    }),
  })),
  IdempotentProducer: vi.fn().mockImplementation(() => ({
    append: mockAppend,
    flush: mockFlush,
    detach: mockDetach,
  })),
}))

import { createClient } from "../src/client.js"

describe(`createClient`, () => {
  const user = { name: `Kyle`, email: `kyle@example.com` }

  beforeEach(() => {
    mockAppend.mockClear()
    mockFlush.mockClear()
    mockDetach.mockClear()
  })

  describe(`prompt`, () => {
    it(`should append a user prompt envelope to the stream`, () => {
      const client = createClient({
        agent: `claude`,
        streamUrl: `https://example.com/v1/stream/test`,
        user,
      })

      client.prompt(`Hello agent`)

      expect(mockAppend).toHaveBeenCalledOnce()
      const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
      expect(written.direction).toBe(`user`)
      expect(written.user).toEqual(user)
      expect(written.raw.type).toBe(`user_message`)
      expect(written.raw.text).toBe(`Hello agent`)
      expect(written.timestamp).toBeTypeOf(`number`)
    })
  })

  describe(`respond`, () => {
    it(`should append a response envelope to the stream`, () => {
      const client = createClient({
        agent: `claude`,
        streamUrl: `https://example.com/v1/stream/test`,
        user,
      })

      client.respond(`req-42`, {
        outcome: { outcome: `selected`, optionId: `allow` },
      })

      expect(mockAppend).toHaveBeenCalledOnce()
      const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
      expect(written.direction).toBe(`user`)
      expect(written.raw.type).toBe(`control_response`)
      expect(written.raw.response.request_id).toBe(`req-42`)
    })
  })

  describe(`cancel`, () => {
    it(`should append a cancel envelope to the stream`, () => {
      const client = createClient({
        agent: `claude`,
        streamUrl: `https://example.com/v1/stream/test`,
        user,
      })

      client.cancel()

      expect(mockAppend).toHaveBeenCalledOnce()
      const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
      expect(written.direction).toBe(`user`)
      expect(written.raw.type).toBe(`interrupt`)
    })
  })

  describe(`close`, () => {
    it(`should flush and detach the producer`, async () => {
      const client = createClient({
        agent: `claude`,
        streamUrl: `https://example.com/v1/stream/test`,
        user,
      })

      await client.close()
      expect(mockFlush).toHaveBeenCalledOnce()
      expect(mockDetach).toHaveBeenCalledOnce()
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: FAIL — `createClient` not exported.

- [ ] **Step 3: Implement `src/client.ts`**

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"
import type {
  ClientOptions,
  StreamClient,
  UserEnvelope,
  StreamEnvelope,
} from "./types.js"

export function createClient(options: ClientOptions): StreamClient {
  const { agent, streamUrl, user, contentType = `application/json` } = options

  const stream = new DurableStream({ url: streamUrl, contentType })
  const producerId = `client-${crypto.randomUUID()}`
  const producer = new IdempotentProducer(stream, producerId, {
    autoClaim: true,
  })

  function writeUserEnvelope(raw: object): void {
    const envelope: UserEnvelope = {
      agent,
      direction: `user`,
      timestamp: Date.now(),
      user,
      raw,
    }
    producer.append(JSON.stringify(envelope))
  }

  return {
    prompt(text: string): void {
      writeUserEnvelope({
        type: `user_message`,
        text,
      })
    },

    respond(requestId: string | number, result: unknown): void {
      writeUserEnvelope({
        type: `control_response`,
        response: {
          request_id: requestId,
          subtype: `success`,
          response: result,
        },
      })
    },

    cancel(): void {
      writeUserEnvelope({ type: `interrupt` })
    },

    async *events(): AsyncIterable<StreamEnvelope> {
      const response = await stream.stream<StreamEnvelope>({
        live: `sse`,
        json: true,
      })
      yield* response.jsonStream()
    },

    async close(): Promise<void> {
      await producer.flush()
      await producer.detach()
    },
  }
}

export type { StreamClient, ClientOptions } from "./types.js"
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agents/src/client.ts packages/coding-agents/test/client.test.ts
git commit -m "feat(coding-agents): add browser-safe client"
```

---

## Task 10: Entrypoints

**Files:**

- Create: `packages/coding-agents/src/index.ts`

- [ ] **Step 1: Implement `src/index.ts`**

```typescript
/**
 * @durable-streams/coding-agents
 *
 * Bridge coding agents to durable streams for persistent, shareable sessions.
 *
 * @packageDocumentation
 */

// ============================================================================
// Bridge API (Node-only)
// ============================================================================

export { startBridge } from "./bridge.js"
export type { BridgeOptions } from "./bridge.js"

// ============================================================================
// Session factory
// ============================================================================

import { startBridge } from "./bridge.js"
import { ClaudeAdapter } from "./adapters/claude.js"
import { CodexAdapter } from "./adapters/codex.js"
import type { SessionOptions, Session } from "./types.js"

export async function createSession(options: SessionOptions): Promise<Session> {
  const { agent, ...rest } = options
  const adapter = agent === `claude` ? new ClaudeAdapter() : new CodexAdapter()
  return startBridge({ adapter, ...rest })
}

// ============================================================================
// Adapters
// ============================================================================

export { ClaudeAdapter } from "./adapters/claude.js"
export { CodexAdapter } from "./adapters/codex.js"

// ============================================================================
// Types
// ============================================================================

export type {
  AgentType,
  User,
  AgentEnvelope,
  UserEnvelope,
  BridgeEnvelope,
  StreamEnvelope,
  SessionOptions,
  Session,
} from "./types.js"

export type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
  SpawnOptions,
  ResumeOptions,
} from "./adapters/types.js"
```

- [ ] **Step 2: Verify `src/client.ts` re-exports normalizers**

Update `src/client.ts` to add normalizer exports at the bottom:

```typescript
// ============================================================================
// Normalizers (tree-shakeable)
// ============================================================================

export { normalizeClaude } from "./normalize/claude.js"
export { normalizeCodex } from "./normalize/codex.js"
export type { NormalizedEvent } from "./normalize/types.js"
export type * from "./normalize/types.js"
```

- [ ] **Step 3: Verify typecheck**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/coding-agents typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agents/src/index.ts packages/coding-agents/src/client.ts
git commit -m "feat(coding-agents): add entrypoints"
```

---

## Task 11: CLI

**Files:**

- Create: `packages/coding-agents/cli/index.ts`

- [ ] **Step 1: Implement `cli/index.ts`**

```typescript
#!/usr/bin/env node

import { parseArgs } from "node:util"
import { createSession } from "../src/index.js"

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: `string`, default: `claude` },
      "stream-url": { type: `string` },
      cwd: { type: `string`, default: process.cwd() },
      model: { type: `string` },
      "permission-mode": { type: `string` },
      verbose: { type: `boolean`, default: false },
    },
  })

  const command = positionals[0]

  if (!command || command === `help`) {
    console.log(`Usage:
  coding-agents start  [options]   Start a new agent session
  coding-agents resume [options]   Resume an existing session

Options:
  --agent <claude|codex>       Agent to use (default: claude)
  --stream-url <url>           Durable stream URL
  --cwd <path>                 Working directory (default: cwd)
  --model <model>              Model name
  --permission-mode <mode>     Permission mode
  --verbose                    Enable verbose output`)
    return
  }

  const baseUrl = process.env.DURABLE_STREAMS_URL
  const streamUrl =
    values[`stream-url`] ??
    (baseUrl ? `${baseUrl}/v1/stream/session-${Date.now()}` : undefined)

  if (!streamUrl) {
    console.error(`Error: --stream-url or DURABLE_STREAMS_URL env var required`)
    process.exit(1)
  }

  const agent = (values.agent as `claude` | `codex`) ?? `claude`

  if (command === `start`) {
    const session = await createSession({
      agent,
      streamUrl,
      cwd: values.cwd ?? process.cwd(),
      model: values.model,
      permissionMode: values[`permission-mode`],
      verbose: values.verbose,
    })

    console.log(`Stream: ${session.streamUrl}`)
    console.log(`Agent ${agent} started. Press Ctrl+C to stop.`)

    process.on(`SIGINT`, async () => {
      console.log(`\nShutting down...`)
      await session.close()
      process.exit(0)
    })

    process.on(`SIGTERM`, async () => {
      await session.close()
      process.exit(0)
    })
  } else if (command === `resume`) {
    const session = await createSession({
      agent,
      streamUrl,
      cwd: values.cwd ?? process.cwd(),
      model: values.model,
      permissionMode: values[`permission-mode`],
      verbose: values.verbose,
      resume: true,
    })

    console.log(`Stream: ${session.streamUrl}`)
    console.log(`Session resumed. Press Ctrl+C to stop.`)

    process.on(`SIGINT`, async () => {
      console.log(`\nShutting down...`)
      await session.close()
      process.exit(0)
    })

    process.on(`SIGTERM`, async () => {
      await session.close()
      process.exit(0)
    })
  } else {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/coding-agents typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agents/cli/index.ts
git commit -m "feat(coding-agents): add CLI (start, resume)"
```

---

## Task 12: Build and verify

**Files:**

- No new files

- [ ] **Step 1: Run full typecheck**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/coding-agents typecheck
```

Expected: No errors.

- [ ] **Step 2: Build the package**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/coding-agents build
```

Expected: clean build producing `dist/index.js`, `dist/index.cjs`, `dist/client.js`, `dist/client.cjs`, `dist/cli/index.js`, and corresponding `.d.ts` files.

- [ ] **Step 3: Verify dist contents**

```bash
ls -la /Users/kylemathews/programs/durable-streams/packages/coding-agents/dist/
```

Expected: at minimum:

- `index.js`, `index.cjs`, `index.d.ts`, `index.d.cts`
- `client.js`, `client.cjs`, `client.d.ts`, `client.d.cts`
- `cli/index.js`

- [ ] **Step 4: Run all tests**

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project coding-agents
```

Expected: All tests PASS.

- [ ] **Step 5: Commit any remaining changes**

```bash
git add packages/coding-agents/
git commit -m "feat(coding-agents): build and verify package"
```

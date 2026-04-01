# @durable-streams/agent-client-protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript library that bridges ACP coding agents to a remote durable stream, enabling durable, multi-device, multi-user coding sessions.

**Architecture:** A bridge (Node-only) spawns an ACP agent subprocess and pipes its stdio JSON-RPC messages to/from a durable stream. A separate browser-safe client writes user prompts to the same stream. Resume uses synthesized replay with path rewriting.

**Tech Stack:** TypeScript, `@durable-streams/client`, vitest, tsdown, Node.js `child_process`

**Spec:** `docs/superpowers/specs/2026-03-31-durable-streams-acp-bridge-design.md`

---

## File structure

```
packages/agent-client-protocol/
  package.json
  tsdown.config.ts
  tsconfig.json
  src/
    index.ts        — exports createAgentStream + types
    client.ts       — exports createStreamClient (browser-safe)
    bridge.ts       — stdio <-> stream forwarding loop
    agent.ts        — spawn ACP process, manage lifecycle
    replay.ts       — read history, build replay text, rewrite paths
    types.ts        — shared types
  test/
    replay.test.ts  — unit tests for replay module
    agent.test.ts   — unit tests for agent resolution + JSON-RPC
    client.test.ts  — unit tests for client message formatting
```

---

### Task 1: Project scaffold

**Files:**

- Create: `packages/agent-client-protocol/package.json`
- Create: `packages/agent-client-protocol/tsdown.config.ts`
- Create: `packages/agent-client-protocol/tsconfig.json`
- Create: `packages/agent-client-protocol/src/index.ts` (placeholder)
- Create: `packages/agent-client-protocol/src/client.ts` (placeholder)
- Create: `packages/agent-client-protocol/src/types.ts` (placeholder)
- Create: `packages/agent-client-protocol/src/replay.ts` (placeholder)
- Create: `packages/agent-client-protocol/src/agent.ts` (placeholder)
- Create: `packages/agent-client-protocol/src/bridge.ts` (placeholder)
- Modify: `vitest.config.ts` (add test project)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@durable-streams/agent-client-protocol",
  "version": "0.1.0",
  "description": "Bridge ACP coding agents to a remote durable stream",
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
  "sideEffects": false,
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@durable-streams/client": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.15.21",
    "tsdown": "^0.9.0",
    "typescript": "^5.9.2",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create tsdown.config.ts**

```typescript
import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
})
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*", "test/**/*", "*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create placeholder source files**

Create these files with minimal content so the project compiles:

`src/types.ts`:

```typescript
export {}
```

`src/replay.ts`:

```typescript
export {}
```

`src/agent.ts`:

```typescript
export {}
```

`src/bridge.ts`:

```typescript
export {}
```

`src/index.ts`:

```typescript
export {}
```

`src/client.ts`:

```typescript
export {}
```

- [ ] **Step 5: Add vitest project to root config**

In `vitest.config.ts`, add to the `projects` array (add the alias entry too):

```typescript
// In the alias object at the top, add:
"@durable-streams/agent-client-protocol": path.resolve(__dirname, "./packages/agent-client-protocol/src"),

// In the projects array, add:
defineProject({
  test: {
    name: "agent-client-protocol",
    include: ["packages/agent-client-protocol/test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
  resolve: { alias },
}),
```

- [ ] **Step 6: Install dependencies and verify**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm install
```

Expected: Clean install, no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-client-protocol/ vitest.config.ts pnpm-lock.yaml
git commit -m "feat: scaffold @durable-streams/agent-client-protocol package"
```

---

### Task 2: Shared types

**Files:**

- Create: `packages/agent-client-protocol/src/types.ts`

- [ ] **Step 1: Write the types module**

```typescript
// Stream message types — every message on the durable stream is one of these

export interface AgentEvent {
  direction: "agent"
  timestamp: number
  payload: JsonRpcMessage
}

export interface UserPrompt {
  direction: "user"
  timestamp: number
  user: { name: string; email: string }
  payload: JsonRpcMessage
}

export interface ControlEvent {
  direction: "agent"
  timestamp: number
  type: "session_resumed" | "session_ended"
  payload?: JsonRpcMessage
}

export type StreamMessage = AgentEvent | UserPrompt | ControlEvent

// Minimal JSON-RPC types (we forward raw messages, don't need full ACP SDK)

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification

// Configuration types

export interface ReplayOptions {
  /** Path rewrites applied to replay events (old path -> new path) */
  rewritePaths?: Record<string, string>
}

export interface StreamOptions {
  url: string
  contentType?: string
  headers?: Record<string, string | (() => string | Promise<string>)>
}

export interface AgentStreamOptions {
  agent: string | { command: string; args?: string[] }
  streamOptions: StreamOptions
  cwd: string
  mcpServers?: unknown[]
  replayOptions?: ReplayOptions
}

export interface AgentStreamSession {
  sessionId: string
  close(): Promise<void>
}

export interface StreamClientOptions {
  streamOptions: StreamOptions
  user: { name: string; email: string }
}

export interface StreamClient {
  prompt(text: string): Promise<void>
  respond(requestId: number | string, result: unknown): Promise<void>
  cancel(): Promise<void>
  close(): Promise<void>
}
```

- [ ] **Step 2: Verify typecheck**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-client-protocol/src/types.ts
git commit -m "feat(agent-client-protocol): add shared types"
```

---

### Task 3: Replay module with tests

**Files:**

- Create: `packages/agent-client-protocol/src/replay.ts`
- Create: `packages/agent-client-protocol/test/replay.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/replay.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { rewritePaths, buildReplayText } from "../src/replay.js"
import type { StreamMessage } from "../src/types.js"

describe("rewritePaths", () => {
  it("should replace all occurrences of each path", () => {
    const text = "file at /old/path/foo.ts and /old/path/bar.ts"
    const result = rewritePaths(text, { "/old/path": "/new/path" })
    expect(result).toBe("file at /new/path/foo.ts and /new/path/bar.ts")
  })

  it("should apply multiple path rewrites", () => {
    const text = "/sandbox-abc/src and /tmp/work/src"
    const result = rewritePaths(text, {
      "/sandbox-abc": "/workspace",
      "/tmp/work": "/workspace",
    })
    expect(result).toBe("/workspace/src and /workspace/src")
  })

  it("should return text unchanged when no paths match", () => {
    const text = "no paths here"
    const result = rewritePaths(text, { "/old": "/new" })
    expect(result).toBe("no paths here")
  })
})

describe("buildReplayText", () => {
  function makeAgentEvent(payload: Record<string, unknown>): StreamMessage {
    return {
      direction: "agent",
      timestamp: 1000,
      payload: payload as StreamMessage["payload"],
    }
  }

  function makeUserEvent(payload: Record<string, unknown>): StreamMessage {
    return {
      direction: "user",
      timestamp: 1000,
      user: { name: "Kyle", email: "kyle@example.com" },
      payload: payload as StreamMessage["payload"],
    }
  }

  it("should serialize all events as JSON-RPC envelopes", () => {
    const messages: StreamMessage[] = [
      makeAgentEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Hello" },
          },
        },
      }),
      makeAgentEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "read_file",
          },
        },
      }),
      makeAgentEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Done" },
          },
        },
      }),
    ]

    const result = buildReplayText(messages)
    const lines = result.split("\n").filter(Boolean)

    // All events are included — tool_call is NOT filtered out
    expect(lines.length).toBeGreaterThanOrEqual(4) // prefix + 3 events
    expect(result).toContain("tool_call")
    expect(result).toContain("read_file")
    expect(result).toContain("Hello")
    expect(result).toContain("Done")
  })

  it("should include both user and agent direction events", () => {
    const messages: StreamMessage[] = [
      makeUserEvent({
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { prompt: [{ type: "text", text: "Do something" }] },
      }),
      makeAgentEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "OK" },
          },
        },
      }),
    ]

    const result = buildReplayText(messages)
    expect(result).toContain('"direction":"user"')
    expect(result).toContain('"direction":"agent"')
    expect(result).toContain("Do something")
    expect(result).toContain("OK")
  })

  it("should serialize each event as a JSON line with direction, timestamp, payload", () => {
    const messages: StreamMessage[] = [
      makeAgentEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "plan" } },
      }),
    ]

    const result = buildReplayText(messages)
    const lines = result.split("\n").filter(Boolean)
    // First line is the prefix
    const eventLine = lines[1]!
    const parsed = JSON.parse(eventLine)
    expect(parsed).toHaveProperty("direction", "agent")
    expect(parsed).toHaveProperty("timestamp", 1000)
    expect(parsed).toHaveProperty("payload")
    expect(parsed.payload.method).toBe("session/update")
  })

  it("should apply path rewriting across serialized JSON", () => {
    const messages: StreamMessage[] = [
      makeAgentEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            rawInput: "read /old/sandbox/src/main.ts",
          },
        },
      }),
    ]

    const result = buildReplayText(messages, {
      rewritePaths: { "/old/sandbox": "/workspace" },
    })
    expect(result).toContain("/workspace/src/main.ts")
    expect(result).not.toContain("/old/sandbox")
  })

  it("should return empty string for empty message list", () => {
    const result = buildReplayText([])
    expect(result).toBe("")
  })

  it("should skip control events (session_resumed, session_ended)", () => {
    const messages: StreamMessage[] = [
      {
        direction: "agent",
        timestamp: 1000,
        type: "session_resumed",
      } as StreamMessage,
      makeAgentEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "plan" } },
      }),
    ]

    const result = buildReplayText(messages)
    expect(result).not.toContain("session_resumed")
    expect(result).toContain("plan")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
```

Expected: FAIL — `rewritePaths` and `buildReplayText` are not exported.

- [ ] **Step 3: Implement replay.ts**

```typescript
import type { StreamMessage, ReplayOptions } from "./types.js"

const REPLAY_PREFIX =
  "Previous session history is replayed below as JSON-RPC envelopes. Use it as context before responding to the latest user prompt.\n"

export function rewritePaths(
  text: string,
  pathMap: Record<string, string>
): string {
  let result = text
  for (const [from, to] of Object.entries(pathMap)) {
    result = result.replaceAll(from, to)
  }
  return result
}

export function buildReplayText(
  messages: StreamMessage[],
  options: ReplayOptions = {}
): string {
  if (messages.length === 0) return ""

  const { rewritePaths: pathMap } = options

  let text = REPLAY_PREFIX

  for (const msg of messages) {
    // Skip control events (session_resumed, session_ended)
    if (
      "type" in msg &&
      (msg.type === "session_resumed" || msg.type === "session_ended")
    ) {
      continue
    }

    const line = JSON.stringify({
      direction: msg.direction,
      timestamp: msg.timestamp,
      payload: msg.payload,
    })
    text += `${line}\n`
  }

  if (pathMap) {
    text = rewritePaths(text, pathMap)
  }

  return text
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-client-protocol/src/replay.ts packages/agent-client-protocol/test/replay.test.ts
git commit -m "feat(agent-client-protocol): add replay module with full-fidelity event serialization"
```

---

### Task 4: Agent module with tests

**Files:**

- Create: `packages/agent-client-protocol/src/agent.ts`
- Create: `packages/agent-client-protocol/test/agent.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/agent.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { resolveAgent } from "../src/agent.js"

describe("resolveAgent", () => {
  it("should resolve 'claude' to claude --acp", () => {
    const result = resolveAgent("claude")
    expect(result.command).toBe("claude")
    expect(result.args).toEqual(["--acp"])
  })

  it("should resolve 'codex' to codex-acp", () => {
    const result = resolveAgent("codex")
    expect(result.command).toBe("codex-acp")
    expect(result.args).toEqual([])
  })

  it("should throw for unknown agent name", () => {
    expect(() => resolveAgent("unknown-agent")).toThrow("Unknown agent")
  })

  it("should pass through custom command objects", () => {
    const result = resolveAgent({
      command: "/usr/local/bin/my-agent",
      args: ["--mode", "acp"],
    })
    expect(result.command).toBe("/usr/local/bin/my-agent")
    expect(result.args).toEqual(["--mode", "acp"])
  })

  it("should default args to empty array for custom commands", () => {
    const result = resolveAgent({ command: "my-agent" })
    expect(result.args).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
```

Expected: FAIL — `resolveAgent` is not exported.

- [ ] **Step 3: Implement agent.ts**

```typescript
import { spawn, type ChildProcess } from "node:child_process"
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js"

const KNOWN_AGENTS: Record<string, { command: string; args: string[] }> = {
  claude: { command: "claude", args: ["--acp"] },
  codex: { command: "codex-acp", args: [] },
}

export type RequestHandler = (
  id: number | string,
  method: string,
  params: unknown
) => void

export interface AgentProcess {
  process: ChildProcess
  sendRequest(method: string, params?: unknown): Promise<JsonRpcResponse>
  sendResponse(id: number | string, result: unknown): void
  sendNotification(method: string, params?: unknown): void
  onNotification(handler: (method: string, params: unknown) => void): void
  onRequest(handler: RequestHandler): void
  onResponse(handler: (response: JsonRpcResponse) => void): void
  kill(): void
}

export function resolveAgent(
  agent: string | { command: string; args?: string[] }
): { command: string; args: string[] } {
  if (typeof agent === "string") {
    const config = KNOWN_AGENTS[agent]
    if (!config) {
      throw new Error(
        `Unknown agent: ${agent}. Use one of: ${Object.keys(KNOWN_AGENTS).join(", ")}`
      )
    }
    return config
  }
  return { command: agent.command, args: agent.args ?? [] }
}

export function spawnAgent(
  agent: string | { command: string; args?: string[] },
  env?: Record<string, string>
): AgentProcess {
  const { command, args } = resolveAgent(agent)

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  })

  let nextId = 1
  const pending = new Map<
    number | string,
    {
      resolve: (r: JsonRpcResponse) => void
      reject: (e: Error) => void
    }
  >()
  let notificationHandler:
    | ((method: string, params: unknown) => void)
    | undefined
  let requestHandler: RequestHandler | undefined
  let responseHandler: ((response: JsonRpcResponse) => void) | undefined

  // Line-buffered stdout reader
  let buffer = ""
  child.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        const hasId = "id" in msg && msg.id !== undefined && msg.id !== null
        const hasMethod = "method" in msg

        if (hasMethod && hasId) {
          // Agent-initiated request (has both id and method)
          requestHandler?.(
            msg.id as number | string,
            msg.method as string,
            msg.params
          )
        } else if (hasMethod) {
          // Notification (method only)
          notificationHandler?.(msg.method as string, msg.params)
        } else if (hasId) {
          // Response to one of our requests (id only)
          const response = msg as JsonRpcResponse
          responseHandler?.(response)
          const p = pending.get(msg.id as number | string)
          if (p) {
            pending.delete(msg.id as number | string)
            p.resolve(response)
          }
        }
      } catch {
        // Skip non-JSON lines (agent debug output on stdout)
      }
    }
  })

  child.on("error", (err) => {
    for (const [, p] of pending) {
      p.reject(err)
    }
    pending.clear()
  })

  child.on("exit", () => {
    for (const [, p] of pending) {
      p.reject(new Error("Agent process exited"))
    }
    pending.clear()
  })

  return {
    process: child,

    sendRequest(method: string, params?: unknown): Promise<JsonRpcResponse> {
      const id = nextId++
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined && { params }),
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin!.write(JSON.stringify(request) + "\n")
      })
    },

    sendResponse(id: number | string, result: unknown): void {
      const response = { jsonrpc: "2.0" as const, id, result }
      child.stdin!.write(JSON.stringify(response) + "\n")
    },

    sendNotification(method: string, params?: unknown): void {
      const notification = {
        jsonrpc: "2.0" as const,
        method,
        ...(params !== undefined && { params }),
      }
      child.stdin!.write(JSON.stringify(notification) + "\n")
    },

    onNotification(handler) {
      notificationHandler = handler
    },

    onRequest(handler) {
      requestHandler = handler
    },

    onResponse(handler) {
      responseHandler = handler
    },

    kill() {
      child.kill()
    },
  }
}

export async function initializeAgent(
  agent: AgentProcess,
  cwd: string,
  mcpServers: unknown[] = []
): Promise<{ sessionId: string }> {
  const initResponse = await agent.sendRequest("initialize", {
    protocolVersion: 1,
    capabilities: {},
    clientInfo: { name: "durable-streams-bridge", version: "0.1.0" },
  })

  if (initResponse.error) {
    throw new Error(`Agent initialize failed: ${initResponse.error.message}`)
  }

  const sessionResponse = await agent.sendRequest("session/new", {
    cwd,
    mcpServers,
  })

  if (sessionResponse.error) {
    throw new Error(`session/new failed: ${sessionResponse.error.message}`)
  }

  const sessionId = (sessionResponse.result as Record<string, unknown>)
    ?.sessionId as string | undefined
  if (!sessionId) {
    throw new Error("session/new response missing sessionId")
  }

  return { sessionId }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-client-protocol/src/agent.ts packages/agent-client-protocol/test/agent.test.ts
git commit -m "feat(agent-client-protocol): add agent spawn and JSON-RPC lifecycle"
```

---

### Task 5: Bridge module

**Files:**

- Create: `packages/agent-client-protocol/src/bridge.ts`

- [ ] **Step 1: Implement bridge.ts**

```typescript
import { DurableStream } from "@durable-streams/client"
import type {
  StreamOptions,
  StreamMessage,
  AgentEvent,
  ControlEvent,
  ReplayOptions,
  JsonRpcMessage,
} from "./types.js"
import { spawnAgent, initializeAgent } from "./agent.js"
import { buildReplayText } from "./replay.js"

export interface BridgeSession {
  sessionId: string
  close(): Promise<void>
}

export async function startBridge(options: {
  agent: string | { command: string; args?: string[] }
  streamOptions: StreamOptions
  cwd: string
  mcpServers?: unknown[]
  replayOptions?: ReplayOptions
}): Promise<BridgeSession> {
  const {
    agent: agentOption,
    streamOptions,
    cwd,
    mcpServers = [],
    replayOptions = {},
  } = options

  const contentType = streamOptions.contentType ?? "application/json"

  // Connect to or create stream
  let stream: DurableStream
  try {
    stream = await DurableStream.create({
      url: streamOptions.url,
      contentType,
      headers: streamOptions.headers,
    })
  } catch (e: unknown) {
    const err = e as { code?: string }
    if (err.code !== "CONFLICT_EXISTS") throw e
    stream = new DurableStream({
      url: streamOptions.url,
      contentType,
      headers: streamOptions.headers,
    })
  }

  // Read existing history — offset tracks position after consumed data
  const historyResponse = await stream.stream<StreamMessage>({ json: true })
  const history = await historyResponse.json()
  const resumeOffset = historyResponse.offset

  // Spawn agent process
  const agent = spawnAgent(agentOption)

  // Register ALL handlers BEFORE sending any messages to the agent.
  // ACP prompt turns emit session/update notifications before the
  // final response — handlers must be in place to capture them.

  // Forward agent notifications → stream
  agent.onNotification((method, params) => {
    const event: AgentEvent = {
      direction: "agent",
      timestamp: Date.now(),
      payload: {
        jsonrpc: "2.0",
        method,
        params,
      } as JsonRpcMessage,
    }
    stream.append(JSON.stringify(event))
  })

  // Forward agent responses (session/prompt results) → stream
  agent.onResponse((response) => {
    const event: AgentEvent = {
      direction: "agent",
      timestamp: Date.now(),
      payload: response as JsonRpcMessage,
    }
    stream.append(JSON.stringify(event))
    // A response to session/prompt marks the end of a turn
    turnInProgress = false
    processQueue()
  })

  // Forward agent-initiated requests → stream.
  // The bridge does NOT handle these locally — clients respond
  // through the stream and the bridge relays responses back.
  agent.onRequest((id, method, params) => {
    const event: AgentEvent = {
      direction: "agent",
      timestamp: Date.now(),
      payload: { jsonrpc: "2.0", id, method, params } as JsonRpcMessage,
    }
    stream.append(JSON.stringify(event))
  })

  // Prompt queue — serializes turns so overlapping prompts don't collide
  let turnInProgress = false
  const promptQueue: Array<{
    params: Record<string, unknown>
  }> = []

  function processQueue(): void {
    if (turnInProgress || promptQueue.length === 0) return
    turnInProgress = true
    const { params } = promptQueue.shift()!
    agent.sendRequest("session/prompt", { ...params, sessionId })
  }

  // Initialize and create session
  const { sessionId } = await initializeAgent(agent, cwd, mcpServers)

  // Handle resume if history exists
  if (history.length > 0) {
    const replayText = buildReplayText(history, replayOptions)
    if (replayText) {
      turnInProgress = true
      agent.sendRequest("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: replayText }],
      })

      const controlEvent: ControlEvent = {
        direction: "agent",
        timestamp: Date.now(),
        type: "session_resumed",
      }
      await stream.append(JSON.stringify(controlEvent))
    }
  }

  // Live-tail stream from current position (after history)
  const abortController = new AbortController()
  const liveStream = await stream.stream<StreamMessage>({
    offset: resumeOffset,
    live: "sse",
    json: true,
    signal: abortController.signal,
  })

  void (async () => {
    try {
      for await (const item of liveStream.jsonStream()) {
        if (item.direction !== "user" || !("payload" in item)) continue

        const payload = item.payload as Record<string, unknown>
        const method = payload.method as string | undefined
        const id = payload.id as number | string | undefined

        if (method === "session/prompt") {
          const params = (payload.params as Record<string, unknown>) ?? {}
          promptQueue.push({ params })
          processQueue()
        } else if (method === "session/cancel") {
          agent.sendNotification("session/cancel", { sessionId })
        } else if (id != null && !method) {
          // Client JSON-RPC response (result or error) — forward to agent
          if ("error" in payload) {
            agent.process.stdin!.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: payload.error,
              }) + "\n"
            )
          } else {
            agent.sendResponse(id, payload.result)
          }
        }
      }
    } catch (e: unknown) {
      const err = e as { name?: string }
      if (err.name !== "AbortError") {
        console.error("Stream forwarding error:", e)
      }
    }
  })()

  return {
    sessionId,
    async close() {
      abortController.abort()

      const endEvent: ControlEvent = {
        direction: "agent",
        timestamp: Date.now(),
        type: "session_ended",
      }
      await stream.append(JSON.stringify(endEvent))

      agent.kill()
    },
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-client-protocol/src/bridge.ts
git commit -m "feat(agent-client-protocol): add bridge forwarding loop"
```

---

### Task 6: Main entrypoint (index.ts)

**Files:**

- Create: `packages/agent-client-protocol/src/index.ts`

- [ ] **Step 1: Write index.ts with re-exports**

```typescript
export { startBridge as createAgentStream } from "./bridge.js"
export type { BridgeSession as AgentStreamSession } from "./bridge.js"
export type {
  AgentStreamOptions,
  StreamMessage,
  AgentEvent,
  UserPrompt,
  ControlEvent,
  ReplayOptions,
  StreamOptions,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./types.js"
```

- [ ] **Step 2: Verify typecheck**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-client-protocol/src/index.ts
git commit -m "feat(agent-client-protocol): add main entrypoint exports"
```

---

### Task 7: Client module with tests

**Files:**

- Create: `packages/agent-client-protocol/src/client.ts`
- Create: `packages/agent-client-protocol/test/client.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/client.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock DurableStream before importing client
const mockAppend = vi.fn().mockResolvedValue(undefined)

vi.mock("@durable-streams/client", () => ({
  DurableStream: vi.fn().mockImplementation(() => ({
    append: mockAppend,
  })),
}))

import { createStreamClient } from "../src/client.js"

describe("createStreamClient", () => {
  const user = { name: "Kyle", email: "kyle@example.com" }

  beforeEach(() => {
    mockAppend.mockClear()
  })

  describe("prompt", () => {
    it("should append a user prompt message to the stream", async () => {
      const client = createStreamClient({
        streamOptions: { url: "https://example.com/stream/test" },
        user,
      })

      await client.prompt("Hello agent")

      expect(mockAppend).toHaveBeenCalledOnce()
      const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
      expect(written.direction).toBe("user")
      expect(written.user).toEqual(user)
      expect(written.payload.method).toBe("session/prompt")
      expect(written.payload.params.prompt).toEqual([
        { type: "text", text: "Hello agent" },
      ])
      expect(written.timestamp).toBeTypeOf("number")
    })

    it("should include jsonrpc version and unique ids", async () => {
      const client = createStreamClient({
        streamOptions: { url: "https://example.com/stream/test" },
        user,
      })

      await client.prompt("first")
      await client.prompt("second")

      const first = JSON.parse(mockAppend.mock.calls[0]![0] as string)
      const second = JSON.parse(mockAppend.mock.calls[1]![0] as string)
      expect(first.payload.jsonrpc).toBe("2.0")
      expect(first.payload.id).not.toBe(second.payload.id)
    })
  })

  describe("respond", () => {
    it("should append a JSON-RPC response to the stream", async () => {
      const client = createStreamClient({
        streamOptions: { url: "https://example.com/stream/test" },
        user,
      })

      await client.respond(42, {
        outcome: { outcome: "selected", optionId: "allow" },
      })

      expect(mockAppend).toHaveBeenCalledOnce()
      const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
      expect(written.direction).toBe("user")
      expect(written.user).toEqual(user)
      expect(written.payload.id).toBe(42)
      expect(written.payload.result).toEqual({
        outcome: { outcome: "selected", optionId: "allow" },
      })
      expect(written.payload).not.toHaveProperty("method")
    })
  })

  describe("cancel", () => {
    it("should append a cancel notification to the stream", async () => {
      const client = createStreamClient({
        streamOptions: { url: "https://example.com/stream/test" },
        user,
      })

      await client.cancel()

      expect(mockAppend).toHaveBeenCalledOnce()
      const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
      expect(written.direction).toBe("user")
      expect(written.user).toEqual(user)
      expect(written.payload.method).toBe("session/cancel")
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
```

Expected: FAIL — `createStreamClient` is not exported.

- [ ] **Step 3: Implement client.ts**

```typescript
import { DurableStream } from "@durable-streams/client"
import type {
  StreamClientOptions,
  StreamClient,
  UserPrompt,
  JsonRpcMessage,
} from "./types.js"

export function createStreamClient(options: StreamClientOptions): StreamClient {
  const { streamOptions, user } = options
  const stream = new DurableStream({
    url: streamOptions.url,
    contentType: streamOptions.contentType ?? "application/json",
    headers: streamOptions.headers,
  })

  let nextId = 1

  return {
    async prompt(text: string): Promise<void> {
      const message: UserPrompt = {
        direction: "user",
        timestamp: Date.now(),
        user,
        payload: {
          jsonrpc: "2.0",
          id: nextId++,
          method: "session/prompt",
          params: {
            prompt: [{ type: "text", text }],
          },
        } as JsonRpcMessage,
      }
      await stream.append(JSON.stringify(message))
    },

    async respond(requestId: number | string, result: unknown): Promise<void> {
      const message: UserPrompt = {
        direction: "user",
        timestamp: Date.now(),
        user,
        payload: {
          jsonrpc: "2.0",
          id: requestId,
          result,
        } as JsonRpcMessage,
      }
      await stream.append(JSON.stringify(message))
    },

    async cancel(): Promise<void> {
      const message: UserPrompt = {
        direction: "user",
        timestamp: Date.now(),
        user,
        payload: {
          jsonrpc: "2.0",
          method: "session/cancel",
        } as JsonRpcMessage,
      }
      await stream.append(JSON.stringify(message))
    },

    async close(): Promise<void> {
      // Stream handle doesn't hold open connections — no cleanup needed
    },
  }
}

export type { StreamClient, StreamClientOptions } from "./types.js"
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-client-protocol/src/client.ts packages/agent-client-protocol/test/client.test.ts
git commit -m "feat(agent-client-protocol): add browser-safe stream client"
```

---

### Task 8: Build, typecheck, and verify exports

**Files:**

- No new files

- [ ] **Step 1: Run full typecheck**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol typecheck
```

Expected: No errors.

- [ ] **Step 2: Build the package**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm --filter @durable-streams/agent-client-protocol build
```

Expected: Clean build producing `dist/index.js`, `dist/index.cjs`, `dist/client.js`, `dist/client.cjs`, and corresponding `.d.ts` files.

- [ ] **Step 3: Verify dist contents**

Run:

```bash
ls -la /Users/kylemathews/programs/durable-streams/packages/agent-client-protocol/dist/
```

Expected: At minimum these files exist:

- `index.js`, `index.cjs`, `index.d.ts`, `index.d.cts`
- `client.js`, `client.cjs`, `client.d.ts`, `client.d.cts`

- [ ] **Step 4: Run all tests one final time**

Run:

```bash
cd /Users/kylemathews/programs/durable-streams && pnpm vitest run --project agent-client-protocol
```

Expected: All tests PASS.

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A packages/agent-client-protocol/
git commit -m "feat(agent-client-protocol): build and verify package"
```

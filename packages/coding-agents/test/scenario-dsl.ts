import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { DurableStream, IdempotentProducer } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { expect } from "vitest"
import { ClaudeAdapter } from "../src/adapters/claude.js"
import { CodexAdapter } from "../src/adapters/codex.js"
import { startBridge } from "../src/bridge.js"
import { createSession } from "../src/index.js"
import { normalizeClaude } from "../src/normalize/claude.js"
import { normalizeCodex } from "../src/normalize/codex.js"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
} from "../src/adapters/types.js"
import type {
  NormalizedEvent,
  PermissionRequestEvent,
} from "../src/normalize/types.js"
import type {
  AgentType,
  BridgeAgentDebugEvent,
  BridgeDebugHooks,
  BridgeEnvelope,
  BridgeEventType,
  BridgeForwardDebugEvent,
  ClientEvent,
  ClientIntent,
  NormalizedAgentStreamEvent,
  Session,
  SessionOptions,
  StreamEnvelope,
  User,
  UserEnvelope,
} from "../src/types.js"

const DEFAULT_TIMEOUT_MS = 10_000
const REAL_AGENT_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 150

type ScenarioPhase = `before_close` | `after_close`
type RuntimeSessionOptions = Omit<
  SessionOptions,
  `agent` | `streamUrl` | `debugHooks`
>
type AssistantMatcher =
  | string
  | RegExp
  | ((text: string, event: NormalizedAgentStreamEvent) => boolean)
type PermissionMatcher =
  | string
  | RegExp
  | ((
      event: PermissionRequestEvent,
      normalizedEvent: NormalizedAgentStreamEvent
    ) => boolean)

interface ScenarioSnapshot {
  agent: AgentType
  streamUrl: string
  history: Array<StreamEnvelope>
  normalizedEvents: Array<ClientEvent>
  forwardedMessages: Array<BridgeForwardDebugEvent>
  agentMessages: Array<BridgeAgentDebugEvent>
}

export interface ScenarioResult extends ScenarioSnapshot {
  name: string
  sessionId: string
  workingDirectory: string
}

interface ScenarioExpectation {
  description: string
  phase: ScenarioPhase
  timeoutMs: number
  assert: (snapshot: ScenarioSnapshot) => void
}

type ScenarioStep = (runtime: ScenarioRuntime) => Promise<void>

type ScenarioModeConfig =
  | {
      kind: `real`
      agent: AgentType
      options: Partial<RuntimeSessionOptions>
    }
  | {
      kind: `scripted`
      agent: AgentType
      options: Partial<RuntimeSessionOptions>
      harness: ScriptedAdapterHarness
    }

interface ScriptedConnectionController {
  readonly sentMessages: Array<object>
  readonly killed: boolean
  simulateMessage: (raw: object) => void
}

interface ScriptedAdapterHarness {
  readonly adapter: AgentAdapter
  readonly connections: Array<ScriptedConnectionController>
  getActiveConnection: () => ScriptedConnectionController | undefined
}

interface ScenarioRuntime {
  name: string
  mode: ScenarioModeConfig
  streamUrl: string
  workingDirectory: string
  session: Session
  sessions: Array<Session>
  clients: Map<string, HarnessClient>
  debugEvents: {
    forwardedMessages: Array<BridgeForwardDebugEvent>
    agentMessages: Array<BridgeAgentDebugEvent>
  }
  startSession: (
    options?: Partial<RuntimeSessionOptions> & { resume?: boolean }
  ) => Promise<Session>
  stop: () => Promise<void>
}

interface HarnessClient {
  prompt: (text: string) => void
  respond: (
    requestId: string | number,
    response: object,
    subtype?: `success` | `cancelled`
  ) => void
  cancel: () => void
  flush: () => Promise<void>
  close: () => Promise<void>
}

type PermissionResponseBuilder =
  | object
  | ((
      request: NormalizedAgentStreamEvent & {
        event: PermissionRequestEvent
      }
    ) => object)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function slugifyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, `-`) || `user`
}

function normalizeHistoryEvent(
  envelope: StreamEnvelope
): ClientEvent | undefined {
  if (envelope.direction === `agent`) {
    const normalizer =
      envelope.agent === `claude` ? normalizeClaude : normalizeCodex
    const event = normalizer(envelope.raw)
    if (!event) {
      return undefined
    }

    return {
      direction: `agent`,
      envelope,
      event,
    } satisfies NormalizedAgentStreamEvent
  }

  return envelope
}

function buildAssistantText(event: NormalizedAgentStreamEvent): string {
  if (event.event.type !== `assistant_message`) {
    return ``
  }

  return event.event.content
    .map((part) => {
      switch (part.type) {
        case `text`:
          return part.text
        case `thinking`:
          return part.text
        case `tool_result`:
          return part.output
        case `tool_use`:
          return JSON.stringify(part.input)
      }
    })
    .join(` `)
    .trim()
}

function matchesAssistantText(
  matcher: AssistantMatcher,
  text: string,
  event: NormalizedAgentStreamEvent
): boolean {
  if (typeof matcher === `string`) {
    return text.includes(matcher)
  }

  if (matcher instanceof RegExp) {
    return matcher.test(text)
  }

  return matcher(text, event)
}

function matchesPermissionRequest(
  matcher: PermissionMatcher | undefined,
  event: NormalizedAgentStreamEvent & {
    event: PermissionRequestEvent
  }
): boolean {
  if (!matcher) {
    return true
  }

  if (typeof matcher === `string`) {
    return event.event.tool === matcher
  }

  if (matcher instanceof RegExp) {
    return matcher.test(
      `${event.event.tool} ${JSON.stringify(event.event.input)}`
    )
  }

  return matcher(event.event, event)
}

function permissionRequestsFromSnapshot(
  snapshot: ScenarioSnapshot,
  matcher?: PermissionMatcher
): Array<
  NormalizedAgentStreamEvent & {
    event: PermissionRequestEvent
  }
> {
  return snapshot.normalizedEvents.filter(
    (
      event
    ): event is NormalizedAgentStreamEvent & {
      event: PermissionRequestEvent
    } => {
      if (
        event.direction !== `agent` ||
        event.event.type !== `permission_request`
      ) {
        return false
      }

      return matchesPermissionRequest(
        matcher,
        event as NormalizedAgentStreamEvent & {
          event: PermissionRequestEvent
        }
      )
    }
  )
}

function normalizeDebugMessage(
  agent: AgentType,
  raw: object
): NormalizedEvent | null {
  return agent === `claude` ? normalizeClaude(raw) : normalizeCodex(raw)
}

function createHarnessClient(
  agent: AgentType,
  streamUrl: string,
  user: User
): HarnessClient {
  const stream = new DurableStream({
    url: streamUrl,
    contentType: `application/json`,
  })
  const producer = new IdempotentProducer(
    stream,
    `scenario-client-${randomUUID()}`,
    {
      autoClaim: true,
    }
  )

  const writeIntent = (raw: ClientIntent): void => {
    producer.append(
      JSON.stringify({
        agent,
        direction: `user`,
        timestamp: Date.now(),
        user,
        raw,
      } satisfies UserEnvelope)
    )
  }

  return {
    prompt(text) {
      writeIntent({ type: `user_message`, text })
    },
    respond(requestId, response, subtype = `success`) {
      writeIntent({
        type: `control_response`,
        response: {
          request_id: requestId,
          subtype,
          response,
        },
      })
    },
    cancel() {
      writeIntent({ type: `interrupt` })
    },
    async flush() {
      await producer.flush()
    },
    async close() {
      await producer.flush()
      await producer.detach()
    },
  }
}

async function readScenarioSnapshot(
  runtime: Pick<ScenarioRuntime, `mode` | `streamUrl` | `debugEvents`>
): Promise<ScenarioSnapshot> {
  const stream = new DurableStream({ url: runtime.streamUrl })
  const response = await stream.stream<StreamEnvelope>({
    json: true,
    live: false,
  })
  const history = await response.json()

  return {
    agent: runtime.mode.agent,
    streamUrl: runtime.streamUrl,
    history,
    normalizedEvents: history
      .map((envelope) => normalizeHistoryEvent(envelope))
      .filter((event): event is ClientEvent => event !== undefined),
    forwardedMessages: [...runtime.debugEvents.forwardedMessages],
    agentMessages: [...runtime.debugEvents.agentMessages],
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

async function waitForExpectation(
  runtime: ScenarioRuntime,
  expectation: ScenarioExpectation
): Promise<ScenarioSnapshot> {
  const deadline = Date.now() + expectation.timeoutMs
  let lastError: unknown = new Error(
    `Expectation never ran: ${expectation.description}`
  )

  while (Date.now() <= deadline) {
    const snapshot = await readScenarioSnapshot(runtime)

    try {
      expectation.assert(snapshot)
      return snapshot
    } catch (error) {
      lastError = error
      await sleep(POLL_INTERVAL_MS)
    }
  }

  throw new Error(
    `Timed out waiting for ${expectation.description}: ${formatError(lastError)}`
  )
}

function bridgeEventAssertion(
  type: BridgeEventType,
  count: number
): (snapshot: ScenarioSnapshot) => void {
  return (snapshot) => {
    const actualCount = snapshot.history.filter(
      (event): event is BridgeEnvelope =>
        event.direction === `bridge` && event.type === type
    ).length

    expect(actualCount).toBe(count)
  }
}

function assistantMessageAssertion(
  matcher: AssistantMatcher
): (snapshot: ScenarioSnapshot) => void {
  return (snapshot) => {
    const found = snapshot.normalizedEvents.some((event) => {
      if (
        event.direction !== `agent` ||
        event.event.type !== `assistant_message`
      ) {
        return false
      }

      return matchesAssistantText(matcher, buildAssistantText(event), event)
    })

    expect(found).toBe(true)
  }
}

function permissionRequestAssertion(
  matcher?: PermissionMatcher
): (snapshot: ScenarioSnapshot) => void {
  return (snapshot) => {
    const found = permissionRequestsFromSnapshot(snapshot, matcher).length > 0
    expect(found).toBe(true)
  }
}

function permissionRequestCountAtLeastAssertion(
  matcher: PermissionMatcher | undefined,
  count: number
): (snapshot: ScenarioSnapshot) => void {
  return (snapshot) => {
    expect(
      permissionRequestsFromSnapshot(snapshot, matcher).length
    ).toBeGreaterThanOrEqual(count)
  }
}

function turnCompleteAssertion(snapshot: ScenarioSnapshot): void {
  const found = countTurnCompleteEvents(snapshot) > 0

  expect(found).toBe(true)
}

function isRawTurnComplete(agent: AgentType, raw: object): boolean {
  const message = raw as Record<string, unknown>

  return agent === `claude`
    ? message.type === `result`
    : message.method === `turn/completed`
}

function countTurnCompleteEvents(snapshot: ScenarioSnapshot): number {
  return snapshot.agentMessages.filter((event) =>
    isRawTurnComplete(snapshot.agent, event.raw)
  ).length
}

function turnCompleteCountAssertion(
  count: number
): (snapshot: ScenarioSnapshot) => void {
  return (snapshot) => {
    const actualCount = countTurnCompleteEvents(snapshot)

    expect(actualCount).toBe(count)
  }
}

function turnCompleteCountAtLeastAssertion(
  count: number
): (snapshot: ScenarioSnapshot) => void {
  return (snapshot) => {
    const actualCount = countTurnCompleteEvents(snapshot)

    expect(actualCount).toBeGreaterThanOrEqual(count)
  }
}

function forwardedCountAssertion(
  predicate: (event: BridgeForwardDebugEvent) => boolean,
  count: number
): (snapshot: ScenarioSnapshot) => void {
  return (snapshot) => {
    const actualCount = snapshot.forwardedMessages.filter(predicate).length
    expect(actualCount).toBe(count)
  }
}

const invariantAssertions: Record<
  string,
  (snapshot: ScenarioSnapshot) => void
> = {
  bridge_lifecycle_well_formed: (snapshot: ScenarioSnapshot): void => {
    const bridgeEvents = snapshot.history.filter(
      (event): event is BridgeEnvelope => event.direction === `bridge`
    )
    const starts = bridgeEvents.filter(
      (event) =>
        event.type === `session_started` || event.type === `session_resumed`
    )
    const ends = bridgeEvents.filter((event) => event.type === `session_ended`)

    expect(starts.length).toBeGreaterThan(0)
    expect(ends).toHaveLength(starts.length)

    for (let index = 0; index < starts.length; index++) {
      expect(starts[index]!.timestamp).toBeLessThanOrEqual(
        ends[index]!.timestamp
      )
    }
  },

  first_response_wins: (snapshot: ScenarioSnapshot): void => {
    const counts = new Map<string | number, number>()

    for (const event of snapshot.forwardedMessages) {
      if (event.source !== `client_response`) {
        continue
      }

      const message = event.raw as Record<string, unknown>
      const requestId =
        (message.response as Record<string, unknown> | undefined)?.request_id ??
        message.id

      if (requestId == null) {
        continue
      }

      const normalizedRequestId = requestId as string | number
      counts.set(
        normalizedRequestId,
        (counts.get(normalizedRequestId) ?? 0) + 1
      )
    }

    for (const count of counts.values()) {
      expect(count).toBeLessThanOrEqual(1)
    }
  },

  single_in_flight_prompt: (snapshot: ScenarioSnapshot): void => {
    const timeline = [
      ...snapshot.forwardedMessages
        .filter((event) => event.source === `queued_prompt`)
        .map((event) => ({
          sequence: event.sequence,
          kind: `prompt` as const,
        })),
      ...snapshot.agentMessages
        .filter((event) => {
          const normalized = normalizeDebugMessage(snapshot.agent, event.raw)
          return normalized?.type === `turn_complete`
        })
        .map((event) => ({
          sequence: event.sequence,
          kind: `turn_complete` as const,
        })),
    ].sort((left, right) => left.sequence - right.sequence)

    let inFlight = 0
    let maxInFlight = 0

    for (const event of timeline) {
      if (event.kind === `prompt`) {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        continue
      }

      inFlight = Math.max(0, inFlight - 1)
    }

    expect(maxInFlight).toBeLessThanOrEqual(1)
  },
}

async function waitForPermissionRequestEvent(
  runtime: ScenarioRuntime,
  matcher: PermissionMatcher | undefined,
  timeoutMs: number,
  count: number = 1
): Promise<
  NormalizedAgentStreamEvent & {
    event: PermissionRequestEvent
  }
> {
  const snapshot = await waitForExpectation(runtime, {
    description: `permission request`,
    phase: `before_close`,
    timeoutMs,
    assert: permissionRequestCountAtLeastAssertion(matcher, count),
  })

  const request = permissionRequestsFromSnapshot(snapshot, matcher).at(
    count - 1
  )
  if (!request) {
    throw new Error(`Permission request disappeared before it could be used`)
  }

  return request
}

function createScriptedAdapterHarness(
  agent: AgentType
): ScriptedAdapterHarness {
  const baseAdapter =
    agent === `claude` ? new ClaudeAdapter() : new CodexAdapter()
  const connections: Array<ScriptedConnectionController> = []
  let activeConnection: ScriptedConnectionController | undefined

  const adapter: AgentAdapter = {
    agentType: agent,

    spawn(): Promise<AgentConnection> {
      let messageHandler: ((raw: object) => void) | null = null
      let exitHandler: ((code: number | null) => void) | null = null
      const sentMessages: Array<object> = []
      let killed = false

      const controller: ScriptedConnectionController = {
        get sentMessages() {
          return sentMessages
        },
        get killed() {
          return killed
        },
        simulateMessage(raw) {
          messageHandler?.(raw)
        },
      }

      activeConnection = controller
      connections.push(controller)

      return Promise.resolve({
        onMessage(handler) {
          messageHandler = handler
        },
        send(raw) {
          sentMessages.push(raw)
        },
        kill() {
          if (killed) {
            return
          }

          killed = true
          exitHandler?.(0)
        },
        on(_event, handler) {
          exitHandler = handler
        },
      })
    },

    parseDirection(raw: object): MessageClassification {
      return baseAdapter.parseDirection(raw)
    },

    isTurnComplete(raw: object): boolean {
      return baseAdapter.isTurnComplete(raw)
    },

    translateClientIntent(raw, user) {
      return baseAdapter.translateClientIntent(raw, user)
    },

    prepareResume() {
      return Promise.resolve({ resumeId: `scripted-resume-${Date.now()}` })
    },
  }

  return {
    adapter,
    connections,
    getActiveConnection() {
      return activeConnection
    },
  }
}

async function createRuntime(
  name: string,
  mode: ScenarioModeConfig,
  users: Map<string, User>
): Promise<ScenarioRuntime> {
  const server = new DurableStreamTestServer({ port: 0 })
  await server.start()

  const debugEvents = {
    forwardedMessages: [] as Array<BridgeForwardDebugEvent>,
    agentMessages: [] as Array<BridgeAgentDebugEvent>,
  }

  const debugHooks: BridgeDebugHooks = {
    onForwardToAgent(event) {
      debugEvents.forwardedMessages.push(event)
    },
    onAgentMessage(event) {
      debugEvents.agentMessages.push(event)
    },
  }

  const streamUrl = `${server.url}/v1/stream/coding-agents-${randomUUID()}`
  const workingDirectory =
    mode.options.cwd ?? (await mkdtemp(join(tmpdir(), `coding-agents-`)))

  const clients = new Map<string, HarnessClient>()
  const runtime = {
    name,
    mode,
    streamUrl,
    workingDirectory,
    session: null as Session | null,
    sessions: [] as Array<Session>,
    clients,
    debugEvents,
    async startSession(
      options: Partial<RuntimeSessionOptions> & { resume?: boolean } = {}
    ): Promise<Session> {
      const nextSession = await openSession(options)
      runtime.session = nextSession
      runtime.sessions.push(nextSession)
      return nextSession
    },
    async stop() {
      await Promise.all(
        [...clients.values()].map(async (client) => {
          try {
            await client.close()
          } catch {
            // Ignore shutdown errors from test clients.
          }
        })
      )

      for (const session of [...runtime.sessions].reverse()) {
        await session.close()
      }

      if (!mode.options.cwd) {
        await rm(workingDirectory, { recursive: true, force: true })
      }

      await server.stop()
    },
  } satisfies {
    name: string
    mode: ScenarioModeConfig
    streamUrl: string
    workingDirectory: string
    session: Session | null
    clients: Map<string, HarnessClient>
    debugEvents: {
      forwardedMessages: Array<BridgeForwardDebugEvent>
      agentMessages: Array<BridgeAgentDebugEvent>
    }
    sessions: Array<Session>
    startSession: (
      options?: Partial<RuntimeSessionOptions> & { resume?: boolean }
    ) => Promise<Session>
    stop: () => Promise<void>
  }

  const openSession = async (
    options: Partial<RuntimeSessionOptions> & { resume?: boolean } = {}
  ): Promise<Session> => {
    const mergedOptions: SessionOptions = {
      agent: mode.agent,
      streamUrl,
      cwd: workingDirectory,
      contentType: `application/json`,
      ...mode.options,
      ...options,
      debugHooks,
    }

    if (mode.kind === `real`) {
      return createSession(mergedOptions)
    }

    return startBridge({
      adapter: mode.harness.adapter,
      streamUrl,
      cwd: mergedOptions.cwd,
      contentType: mergedOptions.contentType,
      model: mergedOptions.model,
      permissionMode: mergedOptions.permissionMode,
      verbose: mergedOptions.verbose,
      rewritePaths: mergedOptions.rewritePaths,
      resume: mergedOptions.resume,
      debugHooks,
    })
  }

  try {
    await runtime.startSession()
    await waitForExpectation(runtime as ScenarioRuntime, {
      description: `initial session start`,
      phase: `before_close`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      assert: bridgeEventAssertion(`session_started`, 1),
    })

    for (const user of users.values()) {
      clients.set(user.name, createHarnessClient(mode.agent, streamUrl, user))
    }

    return runtime as ScenarioRuntime
  } catch (error) {
    if (runtime.session) {
      await runtime.session.close().catch(() => undefined)
    }

    if (!mode.options.cwd) {
      await rm(workingDirectory, { recursive: true, force: true }).catch(
        () => undefined
      )
    }

    await server.stop().catch(() => undefined)
    throw error
  }
}

export class ScenarioBuilder {
  readonly #name: string
  #mode: ScenarioModeConfig | null = null
  #users = new Map<string, User>()
  #currentClientName: string | null = null
  #steps: Array<ScenarioStep> = []
  #expectations: Array<ScenarioExpectation> = []

  constructor(name: string) {
    this.#name = name
  }

  agent(agent: AgentType, options: Partial<RuntimeSessionOptions> = {}): this {
    this.#mode = {
      kind: `real`,
      agent,
      options,
    }
    return this
  }

  scriptedAgent(
    agent: AgentType,
    options: Partial<RuntimeSessionOptions> = {}
  ): this {
    this.#mode = {
      kind: `scripted`,
      agent,
      options,
      harness: createScriptedAdapterHarness(agent),
    }
    return this
  }

  client(name: string, user: Partial<User> = {}): this {
    const normalizedUser = {
      name,
      email: user.email ?? `${slugifyName(name)}@example.com`,
    }

    this.#users.set(name, normalizedUser)
    this.#currentClientName = name
    return this
  }

  useClient(name: string): this {
    if (!this.#users.has(name)) {
      throw new Error(`Unknown client: ${name}`)
    }

    this.#currentClientName = name
    return this
  }

  prompt(text: string): this {
    const clientName = this.#requireCurrentClient()
    this.#steps.push(async (runtime) => {
      const client = runtime.clients.get(clientName)
      if (!client) {
        throw new Error(`Unknown runtime client: ${clientName}`)
      }
      client.prompt(text)
      await client.flush()
    })
    return this
  }

  respond(requestId: string | number, response: object): this {
    const clientName = this.#requireCurrentClient()
    this.#steps.push(async (runtime) => {
      const client = runtime.clients.get(clientName)
      if (!client) {
        throw new Error(`Unknown runtime client: ${clientName}`)
      }
      client.respond(requestId, response)
      await client.flush()
    })
    return this
  }

  respondToLatestPermissionRequest(
    response: PermissionResponseBuilder,
    options: {
      matcher?: PermissionMatcher
      timeoutMs?: number
      subtype?: `success` | `cancelled`
      count?: number
    } = {}
  ): this {
    const clientName = this.#requireCurrentClient()
    this.#steps.push(async (runtime) => {
      const client = runtime.clients.get(clientName)
      if (!client) {
        throw new Error(`Unknown runtime client: ${clientName}`)
      }

      const permissionRequest = await waitForPermissionRequestEvent(
        runtime,
        options.matcher,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.count ?? 1
      )
      const resolvedResponse =
        typeof response === `function` ? response(permissionRequest) : response

      client.respond(
        permissionRequest.event.id,
        resolvedResponse,
        options.subtype ?? `success`
      )
      await client.flush()
    })
    return this
  }

  cancelLatestPermissionRequest(
    options: {
      matcher?: PermissionMatcher
      timeoutMs?: number
      count?: number
    } = {}
  ): this {
    return this.respondToLatestPermissionRequest(
      {},
      {
        ...options,
        subtype: `cancelled`,
      }
    )
  }

  cancel(): this {
    const clientName = this.#requireCurrentClient()
    this.#steps.push(async (runtime) => {
      const client = runtime.clients.get(clientName)
      if (!client) {
        throw new Error(`Unknown runtime client: ${clientName}`)
      }
      client.cancel()
      await client.flush()
    })
    return this
  }

  sleep(ms: number): this {
    this.#steps.push(async () => {
      await sleep(ms)
    })
    return this
  }

  injectAgent(raw: object): this {
    this.#steps.push((runtime) => {
      if (runtime.mode.kind !== `scripted`) {
        throw new Error(`injectAgent() is only available for scripted agents`)
      }

      const connection = runtime.mode.harness.getActiveConnection()
      if (!connection) {
        throw new Error(`No active scripted agent connection`)
      }

      connection.simulateMessage(raw)
      return Promise.resolve()
    })
    return this
  }

  restart(options: Partial<RuntimeSessionOptions> = {}): this {
    this.#steps.push(async (runtime) => {
      const resumeCountBeforeRestart = (
        await readScenarioSnapshot(runtime)
      ).history.filter(
        (event): event is BridgeEnvelope =>
          event.direction === `bridge` && event.type === `session_resumed`
      ).length

      await runtime.session.close()
      await runtime.startSession({
        ...options,
        resume: true,
      })
      await waitForExpectation(runtime, {
        description: `session resumed`,
        phase: `before_close`,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        assert: bridgeEventAssertion(
          `session_resumed`,
          resumeCountBeforeRestart + 1
        ),
      })
    })
    return this
  }

  waitForAssistantMessage(
    matcher: AssistantMatcher,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): this {
    const assertion = assistantMessageAssertion(matcher)
    this.#steps.push(async (runtime) => {
      await waitForExpectation(runtime, {
        description: `assistant message`,
        phase: `before_close`,
        timeoutMs,
        assert: assertion,
      })
    })
    return this
  }

  waitForTurnComplete(timeoutMs: number = DEFAULT_TIMEOUT_MS): this {
    this.#steps.push(async (runtime) => {
      await waitForExpectation(runtime, {
        description: `turn complete`,
        phase: `before_close`,
        timeoutMs,
        assert: turnCompleteAssertion,
      })
    })
    return this
  }

  waitForTurnCompleteCount(
    count: number,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): this {
    this.#steps.push(async (runtime) => {
      await waitForExpectation(runtime, {
        description: `turn complete count ${count}`,
        phase: `before_close`,
        timeoutMs,
        assert: turnCompleteCountAtLeastAssertion(count),
      })
    })
    return this
  }

  waitForPermissionRequest(
    matcher?: PermissionMatcher,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): this {
    this.#steps.push(async (runtime) => {
      await waitForPermissionRequestEvent(runtime, matcher, timeoutMs)
    })
    return this
  }

  waitForForwardedCount(
    predicate: (event: BridgeForwardDebugEvent) => boolean,
    count: number,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): this {
    this.#steps.push(async (runtime) => {
      await waitForExpectation(runtime, {
        description: `forwarded count ${count}`,
        phase: `before_close`,
        timeoutMs,
        assert: forwardedCountAssertion(predicate, count),
      })
    })
    return this
  }

  expectAssistantMessage(
    matcher: AssistantMatcher,
    options: { phase?: ScenarioPhase; timeoutMs?: number } = {}
  ): this {
    this.#expectations.push({
      description: `assistant message`,
      phase: options.phase ?? `after_close`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      assert: assistantMessageAssertion(matcher),
    })
    return this
  }

  expectTurnComplete(
    options: { phase?: ScenarioPhase; timeoutMs?: number } = {}
  ): this {
    this.#expectations.push({
      description: `turn complete`,
      phase: options.phase ?? `after_close`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      assert: turnCompleteAssertion,
    })
    return this
  }

  expectTurnCompleteCount(
    count: number,
    options: { phase?: ScenarioPhase; timeoutMs?: number } = {}
  ): this {
    this.#expectations.push({
      description: `turn complete count ${count}`,
      phase: options.phase ?? `after_close`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      assert: turnCompleteCountAssertion(count),
    })
    return this
  }

  expectPermissionRequest(
    matcher?: PermissionMatcher,
    options: { phase?: ScenarioPhase; timeoutMs?: number } = {}
  ): this {
    this.#expectations.push({
      description: `permission request`,
      phase: options.phase ?? `after_close`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      assert: permissionRequestAssertion(matcher),
    })
    return this
  }

  expectBridgeEvent(
    type: BridgeEventType,
    options: { count?: number; phase?: ScenarioPhase; timeoutMs?: number } = {}
  ): this {
    this.#expectations.push({
      description: `bridge event ${type}`,
      phase: options.phase ?? `after_close`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      assert: bridgeEventAssertion(type, options.count ?? 1),
    })
    return this
  }

  expectForwardedCount(
    predicate: (event: BridgeForwardDebugEvent) => boolean,
    count: number,
    options: { phase?: ScenarioPhase; timeoutMs?: number } = {}
  ): this {
    this.#expectations.push({
      description: `forwarded count ${count}`,
      phase: options.phase ?? `after_close`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      assert: forwardedCountAssertion(predicate, count),
    })
    return this
  }

  expectInvariant(
    name: keyof typeof invariantAssertions,
    options: { phase?: ScenarioPhase; timeoutMs?: number } = {}
  ): this {
    const assertion = invariantAssertions[name]
    if (!assertion) {
      throw new Error(`Unknown invariant: ${String(name)}`)
    }

    this.#expectations.push({
      description: `invariant ${name}`,
      phase: options.phase ?? `after_close`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      assert: assertion,
    })
    return this
  }

  async run(): Promise<ScenarioResult> {
    if (!this.#mode) {
      throw new Error(
        `Scenario ${this.#name} is missing an agent configuration`
      )
    }

    if (this.#users.size === 0) {
      this.client(`default`)
    }

    const runtime = await createRuntime(this.#name, this.#mode, this.#users)

    try {
      for (const step of this.#steps) {
        await step(runtime)
      }

      for (const expectation of this.#expectations.filter(
        (item) => item.phase === `before_close`
      )) {
        await waitForExpectation(runtime, expectation)
      }

      const currentSession =
        runtime.sessions[runtime.sessions.length - 1] ?? runtime.session
      await currentSession.close()

      for (const expectation of this.#expectations.filter(
        (item) => item.phase === `after_close`
      )) {
        await waitForExpectation(runtime, expectation)
      }

      const snapshot = await readScenarioSnapshot(runtime)
      return {
        name: this.#name,
        sessionId: currentSession.sessionId,
        workingDirectory: runtime.workingDirectory,
        ...snapshot,
      }
    } finally {
      await runtime.stop()
    }
  }

  #requireCurrentClient(): string {
    if (!this.#currentClientName) {
      throw new Error(`Scenario ${this.#name} does not have an active client`)
    }

    return this.#currentClientName
  }
}

export function scenario(name: string): ScenarioBuilder {
  return new ScenarioBuilder(name)
}

export { DEFAULT_TIMEOUT_MS, REAL_AGENT_TIMEOUT_MS, invariantAssertions, sleep }
export type {
  ScenarioPhase,
  ScenarioSnapshot,
  AssistantMatcher,
  PermissionMatcher,
}

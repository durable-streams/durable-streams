import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStream, IdempotentProducer } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { startBridge } from "../src/bridge.js"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
} from "../src/adapters/types.js"
import type {
  AgentEnvelope,
  ClientIntent,
  StreamEnvelope,
} from "../src/types.js"

function createMockAdapter(): {
  adapter: AgentAdapter
  connection: {
    simulateMessage: (raw: object) => void
    sentMessages: Array<object>
    killed: boolean
    kill: () => void
  }
} {
  let messageHandler: ((raw: object) => void) | null = null
  let exitHandler: ((code: number | null) => void) | null = null
  const sentMessages: Array<object> = []
  let killed = false

  const connection: AgentConnection = {
    onMessage(handler) {
      messageHandler = handler
    },
    send(raw) {
      sentMessages.push(raw)
    },
    kill() {
      killed = true
      exitHandler?.(0)
    },
    on(_event, handler) {
      exitHandler = handler
    },
  }

  const adapter: AgentAdapter = {
    agentType: `claude`,
    spawn() {
      return Promise.resolve(connection)
    },
    parseDirection(raw: object): MessageClassification {
      const message = raw as Record<string, unknown>
      if (message.type === `control_request`) {
        return { type: `request`, id: message.request_id as string }
      }
      if (message.type === `control_response`) {
        return {
          type: `response`,
          id: (message.response as Record<string, unknown> | undefined)
            ?.request_id as string,
        }
      }
      return { type: `notification` }
    },
    isTurnComplete(raw: object) {
      return (raw as Record<string, unknown>).type === `result`
    },
    translateClientIntent(raw: ClientIntent) {
      return raw
    },
    prepareResume() {
      return Promise.resolve({ resumeId: `mock-resume` })
    },
  }

  return {
    adapter,
    connection: {
      simulateMessage(raw) {
        messageHandler?.(raw)
      },
      sentMessages,
      get killed() {
        return killed
      },
      kill() {
        connection.kill()
      },
    },
  }
}

function createResumeFailingAdapter(): {
  adapter: AgentAdapter
  connection: {
    sentMessages: Array<object>
  }
} {
  const sentMessages: Array<object> = []
  let spawnCount = 0

  return {
    adapter: {
      agentType: `claude`,
      async spawn(options) {
        spawnCount += 1
        if (spawnCount === 1 && options.resume) {
          throw new Error(`resume failed`)
        }

        return {
          onMessage() {},
          send(raw) {
            sentMessages.push(raw)
          },
          kill() {},
          on() {},
        }
      },
      parseDirection() {
        return { type: `notification` }
      },
      isTurnComplete(raw: object) {
        return (raw as Record<string, unknown>).type === `result`
      },
      translateClientIntent(raw: ClientIntent) {
        return raw
      },
      prepareResume() {
        return Promise.resolve({ resumeId: `resume-id` })
      },
    },
    connection: {
      sentMessages,
    },
  }
}

function createRewriteCapturingAdapter(): {
  adapter: AgentAdapter
  getRewritePaths: () => Record<string, string> | undefined
} {
  let rewritePaths: Record<string, string> | undefined

  return {
    adapter: {
      agentType: `claude`,
      async spawn() {
        return {
          onMessage() {},
          send() {},
          kill() {},
          on() {},
        }
      },
      parseDirection() {
        return { type: `notification` }
      },
      isTurnComplete() {
        return false
      },
      translateClientIntent(raw: ClientIntent) {
        return raw
      },
      prepareResume(_history, options) {
        rewritePaths = options.rewritePaths
        return Promise.reject(new Error(`captured rewrite paths`))
      },
    },
    getRewritePaths() {
      return rewritePaths
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
    })

    connection.simulateMessage({ type: `assistant`, message: { content: [] } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<AgentEnvelope>({
      json: true,
      live: false,
    })
    const items = await response.json()

    const agentMessages = items.filter(
      (item: AgentEnvelope) => (item as StreamEnvelope).direction === `agent`
    )

    expect(agentMessages).toHaveLength(1)
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
    })

    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const clientProducer = new IdempotentProducer(clientStream, `test-client`, {
      autoClaim: true,
    })

    clientProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `user`,
        timestamp: Date.now(),
        user: { name: `Test`, email: `test@test.com` },
        raw: { type: `user_message`, text: `Hello` },
      })
    )
    await clientProducer.flush()

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(connection.sentMessages).toContainEqual({
      type: `user_message`,
      text: `Hello`,
    })

    await clientProducer.detach()
    await session.close()
  })

  it(`should drop duplicate responses for the same request ID`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-dedup-${Date.now()}`
    const { adapter, connection } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
    })

    connection.simulateMessage({
      type: `control_request`,
      request_id: `perm-1`,
      request: { subtype: `can_use_tool`, tool_name: `Bash` },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const clientProducer = new IdempotentProducer(clientStream, `test-dedup`, {
      autoClaim: true,
    })

    clientProducer.append(
      JSON.stringify({
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
      })
    )
    clientProducer.append(
      JSON.stringify({
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
      })
    )
    await clientProducer.flush()

    await new Promise((resolve) => setTimeout(resolve, 300))

    const controlResponses = connection.sentMessages.filter(
      (message) =>
        (message as Record<string, unknown>).type === `control_response`
    )

    expect(controlResponses).toHaveLength(1)

    await clientProducer.detach()
    await session.close()
  })

  it(`should write session_started on startup`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-start-${Date.now()}`
    const { adapter } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<StreamEnvelope>({
      json: true,
      live: false,
    })
    const items = await response.json()

    const bridgeEvents = items.filter(
      (
        item: StreamEnvelope
      ): item is Extract<StreamEnvelope, { direction: `bridge` }> =>
        item.direction === `bridge`
    )

    expect(bridgeEvents[0]?.type).toBe(`session_started`)

    await session.close()
  })

  it(`should keep persisted bridge debug events disabled by default`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-debug-default-${Date.now()}`
    const { adapter, connection } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
    })

    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const clientProducer = new IdempotentProducer(
      clientStream,
      `test-debug-default`,
      {
        autoClaim: true,
      }
    )

    clientProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `user`,
        timestamp: Date.now(),
        user: { name: `Test`, email: `test@test.com` },
        raw: { type: `user_message`, text: `Hello` },
      })
    )
    await clientProducer.flush()
    await new Promise((resolve) => setTimeout(resolve, 150))

    connection.simulateMessage({ type: `assistant`, message: { content: [] } })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<StreamEnvelope>({
      json: true,
      live: false,
    })
    const items = await response.json()
    const bridgeTypes = items
      .filter(
        (
          item: StreamEnvelope
        ): item is Extract<StreamEnvelope, { direction: `bridge` }> =>
          item.direction === `bridge`
      )
      .map((event) => event.type)

    expect(bridgeTypes).toEqual([`session_started`])

    await clientProducer.detach()
    await session.close()
  })

  it(`should persist bridge debug events when debugStream is enabled`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-debug-enabled-${Date.now()}`
    const { adapter, connection } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
      debugStream: true,
    })

    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const clientProducer = new IdempotentProducer(
      clientStream,
      `test-debug-enabled`,
      {
        autoClaim: true,
      }
    )

    clientProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `user`,
        timestamp: Date.now(),
        user: { name: `Test`, email: `test@test.com` },
        raw: { type: `user_message`, text: `Hello` },
      })
    )
    await clientProducer.flush()
    await new Promise((resolve) => setTimeout(resolve, 150))

    connection.simulateMessage({ type: `assistant`, message: { content: [] } })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<StreamEnvelope>({
      json: true,
      live: false,
    })
    const items = await response.json()
    const bridgeEvents = items.filter(
      (
        item: StreamEnvelope
      ): item is Extract<StreamEnvelope, { direction: `bridge` }> =>
        item.direction === `bridge`
    )

    expect(bridgeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: `forwarded_to_agent`,
          source: `queued_prompt`,
          raw: { type: `user_message`, text: `Hello` },
        }),
        expect.objectContaining({
          type: `agent_message_received`,
          raw: { type: `assistant`, message: { content: [] } },
        }),
      ])
    )

    await clientProducer.detach()
    await session.close()
  })

  it(`should replay an unfinished prompt after resume`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-replay-prompt-${Date.now()}`
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })

    const seedStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const seedProducer = new IdempotentProducer(seedStream, `seed-prompt`, {
      autoClaim: true,
    })

    seedProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `user`,
        timestamp: Date.now(),
        user: { name: `Test`, email: `test@test.com` },
        raw: { type: `user_message`, text: `Replay me` },
      })
    )
    await seedProducer.flush()
    await seedProducer.detach()

    const { adapter, connection } = createMockAdapter()
    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
      resume: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(connection.sentMessages).toContainEqual({
      type: `user_message`,
      text: `Replay me`,
    })

    await session.close()
  })

  it(`should pass rewritePaths through to adapter.prepareResume`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-rewrite-paths-${Date.now()}`
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })

    const seedStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const seedProducer = new IdempotentProducer(seedStream, `seed-rewrite`, {
      autoClaim: true,
    })

    seedProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `agent`,
        timestamp: Date.now(),
        raw: { type: `system`, session_id: `resume-id` },
      })
    )
    await seedProducer.flush()
    await seedProducer.detach()

    const rewritePaths = {
      [`/old/workspace`]: `/new/workspace`,
    }
    const { adapter, getRewritePaths } = createRewriteCapturingAdapter()
    await expect(
      startBridge({
        adapter,
        streamUrl,
        cwd: `/tmp`,
        resume: true,
        rewritePaths,
      })
    ).rejects.toThrow(`captured rewrite paths`)

    expect(getRewritePaths()).toEqual(rewritePaths)
  })

  it(`should write session_ended when the agent exits mid-turn`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-agent-exit-${Date.now()}`
    const { adapter, connection } = createMockAdapter()

    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
    })

    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const clientProducer = new IdempotentProducer(clientStream, `test-exit`, {
      autoClaim: true,
    })

    clientProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `user`,
        timestamp: Date.now(),
        user: { name: `Test`, email: `test@test.com` },
        raw: { type: `user_message`, text: `Exit mid-turn` },
      })
    )
    await clientProducer.flush()

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(connection.sentMessages).toContainEqual({
      type: `user_message`,
      text: `Exit mid-turn`,
    })

    connection.simulateMessage({
      type: `assistant`,
      message: { content: [{ type: `text`, text: `working` }] },
    })
    connection.kill()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<StreamEnvelope>({
      json: true,
      live: false,
    })
    const items = await response.json()

    const bridgeEvents = items.filter(
      (
        item: StreamEnvelope
      ): item is Extract<StreamEnvelope, { direction: `bridge` }> =>
        item.direction === `bridge`
    )

    expect(bridgeEvents.map((event) => event.type)).toEqual([
      `session_started`,
      `session_ended`,
    ])

    await clientProducer.detach()
    await session.close()
  })

  it(`should replay the unfinished prompt after an agent exits mid-turn and the bridge resumes`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-agent-exit-replay-${Date.now()}`
    const first = createMockAdapter()

    const firstSession = await startBridge({
      adapter: first.adapter,
      streamUrl,
      cwd: `/tmp`,
    })

    const clientStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const clientProducer = new IdempotentProducer(
      clientStream,
      `test-exit-replay`,
      {
        autoClaim: true,
      }
    )

    clientProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `user`,
        timestamp: Date.now(),
        user: { name: `Test`, email: `test@test.com` },
        raw: { type: `user_message`, text: `Replay after exit` },
      })
    )
    await clientProducer.flush()

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(first.connection.sentMessages).toContainEqual({
      type: `user_message`,
      text: `Replay after exit`,
    })

    first.connection.kill()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const second = createMockAdapter()
    const resumedSession = await startBridge({
      adapter: second.adapter,
      streamUrl,
      cwd: `/tmp`,
      resume: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(second.connection.sentMessages).toContainEqual({
      type: `user_message`,
      text: `Replay after exit`,
    })

    const stream = new DurableStream({ url: streamUrl })
    const response = await stream.stream<StreamEnvelope>({
      json: true,
      live: false,
    })
    const items = await response.json()

    const bridgeEvents = items.filter(
      (
        item: StreamEnvelope
      ): item is Extract<StreamEnvelope, { direction: `bridge` }> =>
        item.direction === `bridge`
    )

    expect(bridgeEvents.map((event) => event.type)).toEqual([
      `session_started`,
      `session_ended`,
      `session_resumed`,
    ])

    await clientProducer.detach()
    await resumedSession.close()
    await firstSession.close()
  })

  it(`should fall back to a fresh spawn and replay unfinished prompts when resume fails`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/bridge-replay-fallback-${Date.now()}`
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })

    const seedStream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    const seedProducer = new IdempotentProducer(seedStream, `seed-fallback`, {
      autoClaim: true,
    })

    seedProducer.append(
      JSON.stringify({
        agent: `claude`,
        direction: `user`,
        timestamp: Date.now(),
        user: { name: `Test`, email: `test@test.com` },
        raw: { type: `user_message`, text: `Fallback replay` },
      })
    )
    await seedProducer.flush()
    await seedProducer.detach()

    const { adapter, connection } = createResumeFailingAdapter()
    const session = await startBridge({
      adapter,
      streamUrl,
      cwd: `/tmp`,
      resume: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(connection.sentMessages).toContainEqual({
      type: `user_message`,
      text: `Fallback replay`,
    })

    await session.close()
  })
})

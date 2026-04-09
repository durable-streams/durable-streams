import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { createAgentDB } from "../../src/agent-db.js"

describe(`agentdb actions`, () => {
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

  it(`optimistically inserts prompts and settles them against persisted txid rows`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/agentdb-actions-prompt-${Date.now()}`
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })

    const db = createAgentDB({
      streamOptions: {
        url: streamUrl,
        contentType: `application/json`,
      },
    })

    const tx = db.actions.prompt({
      agent: `claude`,
      user: {
        name: `Alice`,
        email: `alice@example.com`,
      },
      text: `hello`,
    })

    expect(db.collections.messages.size).toBe(1)
    expect(db.collections.turns.size).toBe(1)
    const optimisticMessage = db.collections.messages.toArray[0]
    expect(optimisticMessage?.id.startsWith(`tx:`)).toBe(true)
    expect(optimisticMessage).toMatchObject({
      role: `user`,
      kind: `user_message`,
      status: `completed`,
    })

    await tx.isPersisted.promise

    expect(db.collections.messages.size).toBe(1)
    expect(db.collections.turns.size).toBe(1)
    expect(db.collections.message_parts.size).toBe(1)
    expect(db.collections.messages.toArray[0]?.id).toBe(optimisticMessage?.id)
    expect(db.collections.message_parts.toArray[0]).toMatchObject({
      text: `hello`,
    })

    db.close()
  })

  it(`optimistically resolves approval responses and settles without duplicate rows`, async () => {
    const streamUrl = `${baseUrl}/v1/stream/agentdb-actions-approval-${Date.now()}`
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })

    const db = createAgentDB({
      streamOptions: {
        url: streamUrl,
        contentType: `application/json`,
      },
    })

    db.collections.permission_requests.insert({
      id: `perm-1`,
      sessionId: streamUrl.split(`/`).at(-1) ?? streamUrl,
      status: `pending`,
      requestedAt: new Date().toISOString(),
    })

    const tx = db.actions.respond({
      agent: `claude`,
      user: {
        name: `Bob`,
        email: `bob@example.com`,
      },
      requestId: `perm-1`,
      response: {
        behavior: `allow`,
        updatedInput: {
          command: `ls`,
        },
      },
    })

    expect(db.collections.approval_responses.size).toBe(1)
    expect(db.collections.permission_requests.get(`perm-1`)).toMatchObject({
      status: `approved`,
      resolvedByParticipantId: `Bob<bob@example.com>`,
    })

    await tx.isPersisted.promise

    expect(db.collections.approval_responses.size).toBe(1)
    expect(db.collections.permission_requests.get(`perm-1`)).toMatchObject({
      status: `approved`,
      effectiveResponseId: db.collections.approval_responses.toArray[0]?.id,
    })

    db.close()
  })
})

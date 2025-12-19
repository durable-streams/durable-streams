import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/writer"
import { createStreamDB, defineStreamState } from "../src/index"
import type { StandardSchemaV1 } from "@standard-schema/spec"

// Simple Standard Schema implementations for testing
const userSchema: StandardSchemaV1<{ name: string; email: string }> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { name?: unknown }).name !== `string` ||
        typeof (value as { email?: unknown }).email !== `string`
      ) {
        return { issues: [{ message: `Invalid user` }] }
      }
      return { value: value as { name: string; email: string } }
    },
  },
}

const messageSchema: StandardSchemaV1<{ text: string; userId: string }> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { text?: unknown }).text !== `string` ||
        typeof (value as { userId?: unknown }).userId !== `string`
      ) {
        return { issues: [{ message: `Invalid message` }] }
      }
      return { value: value as { text: string; userId: string } }
    },
  },
}

describe(`Stream DB`, () => {
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

  it(`should define stream state and create db with collections`, async () => {
    // Define the stream state structure
    const streamState = defineStreamState({
      collections: {
        users: {
          schema: userSchema,
          type: `user`, // Maps to change event type field
        },
        messages: {
          schema: messageSchema,
          type: `message`,
        },
      },
    })

    // Create a durable stream
    const streamPath = `/db/chat-${Date.now()}`
    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    // Create the stream DB
    const db = await createStreamDB({
      stream,
      state: streamState,
    })

    // Verify collections are accessible
    expect(db.users).toBeDefined()
    expect(db.messages).toBeDefined()

    // Write change events in parallel
    await Promise.all([
      stream.append({
        type: `user`,
        key: `1`,
        value: { name: `Kyle`, email: `kyle@example.com` },
        headers: { operation: `insert` },
      }),
      stream.append({
        type: `user`,
        key: `2`,
        value: { name: `Alice`, email: `alice@example.com` },
        headers: { operation: `insert` },
      }),
      stream.append({
        type: `message`,
        key: `msg1`,
        value: { text: `Hello!`, userId: `1` },
        headers: { operation: `insert` },
      }),
    ])

    // Preload (eager mode waits for all data to sync)
    await db.preload()

    // Query using TanStack DB collection interface
    const kyle = await db.users.get(`1`)
    const alice = await db.users.get(`2`)
    const msg = await db.messages.get(`msg1`)

    expect(kyle?.name).toBe(`Kyle`)
    expect(kyle?.email).toBe(`kyle@example.com`)
    expect(alice?.name).toBe(`Alice`)
    expect(msg?.text).toBe(`Hello!`)
    expect(msg?.userId).toBe(`1`)
  })
})

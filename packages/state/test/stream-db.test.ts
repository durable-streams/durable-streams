import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import { createStateSchema, createStreamDB } from "../src/stream-db"
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
    const streamState = createStateSchema({
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

    // Verify returned values don't have internal properties visible
    expect(Object.keys(kyle || {})).toEqual([`name`, `email`])

    // Cleanup
    db.close()
  })

  it(`should handle update operations`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/update-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Insert then update
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@old.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@new.com` },
      headers: { operation: `update` },
    })

    await db.preload()

    const user = db.users.get(`1`)
    expect(user?.email).toBe(`kyle@new.com`)

    db.close()
  })

  it(`should handle delete operations`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/delete-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Insert then delete
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      headers: { operation: `delete` },
    })

    await db.preload()

    const user = db.users.get(`1`)
    expect(user).toBeUndefined()

    db.close()
  })

  it(`should handle empty streams`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/empty-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // No events written, just preload
    await db.preload()

    const user = db.users.get(`1`)
    expect(user).toBeUndefined()
    expect(db.users.size).toBe(0)

    db.close()
  })

  it(`should ignore unknown event types`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/unknown-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Write events with unknown types (should be ignored)
    await stream.append({
      type: `unknown_type`,
      key: `1`,
      value: { foo: `bar` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()

    // User should be inserted, unknown type ignored
    expect(db.users.get(`1`)?.name).toBe(`Kyle`)
    expect(db.users.size).toBe(1)

    db.close()
  })

  it(`should receive live updates after preload`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/live-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()
    expect(db.users.get(`1`)?.name).toBe(`Kyle`)

    // Write more events AFTER preload
    await stream.append({
      type: `user`,
      key: `2`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert` },
    })

    // Wait a bit for live update to arrive
    await new Promise((resolve) => setTimeout(resolve, 50))

    // New user should be visible
    expect(db.users.get(`2`)?.name).toBe(`Alice`)

    db.close()
  })

  it(`should route events to correct collections by type`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
        messages: { schema: messageSchema, type: `message` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/routing-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Mix of user and message events
    await stream.append({
      type: `message`,
      key: `m1`,
      value: { text: `First`, userId: `1` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `message`,
      key: `m2`,
      value: { text: `Second`, userId: `1` },
      headers: { operation: `insert` },
    })

    await db.preload()

    // Verify correct routing
    expect(db.users.size).toBe(1)
    expect(db.messages.size).toBe(2)
    expect(db.users.get(`1`)?.name).toBe(`Kyle`)
    expect(db.messages.get(`m1`)?.text).toBe(`First`)
    expect(db.messages.get(`m2`)?.text).toBe(`Second`)

    db.close()
  })

  it(`should handle repeated operations on the same key`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/repeated-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Sequence of operations on the same key
    // 1. Insert
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@v1.com` },
      headers: { operation: `insert` },
    })
    // 2. Update
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle Smith`, email: `kyle@v2.com` },
      headers: { operation: `update` },
    })
    // 3. Another update
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle J Smith`, email: `kyle@v3.com` },
      headers: { operation: `update` },
    })
    // 4. Delete
    await stream.append({
      type: `user`,
      key: `1`,
      headers: { operation: `delete` },
    })
    // 5. Re-insert with new data
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `New Kyle`, email: `newkyle@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()

    // Final state should be the re-inserted value
    const user = db.users.get(`1`)
    expect(user?.name).toBe(`New Kyle`)
    expect(user?.email).toBe(`newkyle@example.com`)
    expect(db.users.size).toBe(1)

    db.close()
  })

  it(`should handle interleaved operations on multiple keys`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/interleaved-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Interleaved operations on different keys
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `2`,
      value: { name: `Bob`, email: `bob@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Alice Updated`, email: `alice@new.com` },
      headers: { operation: `update` },
    })
    await stream.append({
      type: `user`,
      key: `3`,
      value: { name: `Charlie`, email: `charlie@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `2`,
      headers: { operation: `delete` },
    })
    await stream.append({
      type: `user`,
      key: `3`,
      value: { name: `Charlie Updated`, email: `charlie@new.com` },
      headers: { operation: `update` },
    })

    await db.preload()

    // Verify final state
    expect(db.users.size).toBe(2) // Alice and Charlie remain, Bob deleted
    expect(db.users.get(`1`)?.name).toBe(`Alice Updated`)
    expect(db.users.get(`2`)).toBeUndefined() // Bob was deleted
    expect(db.users.get(`3`)?.name).toBe(`Charlie Updated`)

    db.close()
  })

  it(`should batch commit changes only on upToDate`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/batch-commit-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Track change batches using subscribeChanges
    const changeBatches: Array<Array<{ key: string; type: string }>> = []
    db.users.subscribeChanges((changes) => {
      changeBatches.push(
        changes.map((c) => ({ key: String(c.key), type: c.type }))
      )
    })

    // Write many events - these should all be committed together
    const events = []
    for (let i = 0; i < 10; i++) {
      events.push(
        stream.append({
          type: `user`,
          key: String(i),
          value: { name: `User ${i}`, email: `user${i}@example.com` },
          headers: { operation: `insert` },
        })
      )
    }
    await Promise.all(events)

    // After preload, ALL data should be available atomically
    await db.preload()

    // Verify all 10 users are present - batch commit worked
    expect(db.users.size).toBe(10)
    for (let i = 0; i < 10; i++) {
      const user = db.users.get(String(i))
      expect(user?.name).toBe(`User ${i}`)
      expect(user?.email).toBe(`user${i}@example.com`)
    }

    // Verify changes were batched (fewer callbacks than individual events)
    // If commits happened per-event, we'd have 10 callbacks with 1 change each
    // With batch commits, we should have fewer callbacks with multiple changes each
    const nonEmptyBatches = changeBatches.filter((b) => b.length > 0)
    const totalChanges = nonEmptyBatches.reduce(
      (sum, batch) => sum + batch.length,
      0
    )
    expect(totalChanges).toBe(10)
    expect(nonEmptyBatches.length).toBeLessThan(10) // Batched, not one-by-one

    // Verify at least one batch had multiple changes (proves batching)
    const maxBatchSize = Math.max(...nonEmptyBatches.map((b) => b.length))
    expect(maxBatchSize).toBeGreaterThan(1)

    db.close()
  })

  it(`should commit live updates in batches`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/live-batch-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Initial data
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Initial`, email: `initial@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()
    expect(db.users.get(`1`)?.name).toBe(`Initial`)

    // Now write more events that should be batched in subsequent commits
    await stream.append({
      type: `user`,
      key: `2`,
      value: { name: `Second`, email: `second@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `3`,
      value: { name: `Third`, email: `third@example.com` },
      headers: { operation: `insert` },
    })

    // Wait for live updates to arrive and be committed
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Both new users should be visible (committed together in batch)
    expect(db.users.size).toBe(3)
    expect(db.users.get(`2`)?.name).toBe(`Second`)
    expect(db.users.get(`3`)?.name).toBe(`Third`)

    db.close()
  })

  it(`should reject primitive values (non-objects)`, async () => {
    const streamState = createStateSchema({
      collections: {
        config: {
          schema: {
            "~standard": {
              version: 1,
              vendor: `test`,
              validate: (value) => ({ value: value as string }),
            },
          },
          type: `config`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/primitives-${Date.now()}`,
      contentType: `application/json`,
    })

    // Append the primitive value BEFORE creating the DB
    await stream.append({
      type: `config`,
      key: `theme`,
      value: `dark`, // primitive string, not an object
      headers: { operation: `insert` },
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Should throw when trying to process the primitive value during preload
    await expect(db.preload()).rejects.toThrow(
      /StreamDB collections require object values/
    )

    db.close()
  })

  it(`should reject duplicate event types across collections`, async () => {
    // Two collections mapping to the same event type should throw
    expect(() => {
      createStateSchema({
        collections: {
          users: {
            schema: userSchema,
            type: `person`, // same type
          },
          admins: {
            schema: userSchema,
            type: `person`, // duplicate!
          },
        },
      })
    }).toThrow(/duplicate event type/i)
  })

  it(`should reject reserved collection names`, async () => {
    // Collection names that collide with StreamDB methods should throw
    expect(() => {
      createStateSchema({
        collections: {
          preload: {
            // reserved name!
            schema: userSchema,
            type: `user`,
          },
        },
      })
    }).toThrow(/reserved collection name/i)

    expect(() => {
      createStateSchema({
        collections: {
          close: {
            // reserved name!
            schema: userSchema,
            type: `user`,
          },
        },
      })
    }).toThrow(/reserved collection name/i)
  })
})

describe(`State Schema Event Helpers`, () => {
  it(`should create insert events with correct structure`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
      },
    })

    const insertEvent = stateSchema.collections.users.insert({
      key: `123`,
      value: { name: `Kyle`, email: `kyle@example.com` },
    })

    expect(insertEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })
  })

  it(`should create update events with correct structure`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
      },
    })

    const updateEvent = stateSchema.collections.users.update({
      key: `123`,
      value: { name: `Kyle M`, email: `kyle@example.com` },
      oldValue: { name: `Kyle`, email: `kyle@example.com` },
    })

    expect(updateEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { name: `Kyle M`, email: `kyle@example.com` },
      old_value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `update` },
    })
  })

  it(`should create update events without old_value`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
      },
    })

    const updateEvent = stateSchema.collections.users.update({
      key: `123`,
      value: { name: `Kyle M`, email: `kyle@example.com` },
    })

    expect(updateEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { name: `Kyle M`, email: `kyle@example.com` },
      old_value: undefined,
      headers: { operation: `update` },
    })
  })

  it(`should create delete events with correct structure`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
      },
    })

    const deleteEvent = stateSchema.collections.users.delete({
      key: `123`,
      oldValue: { name: `Kyle`, email: `kyle@example.com` },
    })

    expect(deleteEvent).toEqual({
      type: `user`,
      key: `123`,
      old_value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `delete` },
    })
  })

  it(`should create delete events without old_value`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
      },
    })

    const deleteEvent = stateSchema.collections.users.delete({
      key: `123`,
    })

    expect(deleteEvent).toEqual({
      type: `user`,
      key: `123`,
      old_value: undefined,
      headers: { operation: `delete` },
    })
  })

  it(`should use correct event type for different collections`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
        messages: {
          schema: messageSchema,
          type: `message`,
        },
      },
    })

    const userEvent = stateSchema.collections.users.insert({
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
    })
    const messageEvent = stateSchema.collections.messages.insert({
      key: `msg1`,
      value: { text: `Hello`, userId: `1` },
    })

    expect(userEvent.type).toBe(`user`)
    expect(messageEvent.type).toBe(`message`)
  })

  it(`should support custom headers including txid and timestamp`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
      },
    })

    const insertEvent = stateSchema.collections.users.insert({
      key: `123`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: {
        txid: `tx-001`,
        timestamp: `2025-01-15T12:00:00Z`,
        sourceApp: `web-app`,
      },
    })

    expect(insertEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: {
        operation: `insert`,
        txid: `tx-001`,
        timestamp: `2025-01-15T12:00:00Z`,
        sourceApp: `web-app`,
      },
    })
  })
})

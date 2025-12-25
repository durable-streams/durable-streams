import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import { createCollection } from "@tanstack/db"
import {
  changeToStateEvent,
  changesToStateEvents,
  syncCollectionToStream,
  syncCollectionsToStream,
} from "../src/sync"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ChangeMessage, SyncConfig } from "@tanstack/db/types"

// Simple Standard Schema implementations for testing
const userSchema: StandardSchemaV1<{
  id: string
  name: string
  email: string
}> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { id?: unknown }).id !== `string` ||
        typeof (value as { name?: unknown }).name !== `string` ||
        typeof (value as { email?: unknown }).email !== `string`
      ) {
        return { issues: [{ message: `Invalid user` }] }
      }
      return {
        value: value as { id: string; name: string; email: string },
      }
    },
  },
}

const messageSchema: StandardSchemaV1<{
  id: string
  text: string
  userId: string
}> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { id?: unknown }).id !== `string` ||
        typeof (value as { text?: unknown }).text !== `string` ||
        typeof (value as { userId?: unknown }).userId !== `string`
      ) {
        return { issues: [{ message: `Invalid message` }] }
      }
      return {
        value: value as { id: string; text: string; userId: string },
      }
    },
  },
}

// Minimal sync config for testing - just marks collection as ready immediately
function createTestSyncConfig<T extends object>(): SyncConfig<T, string> {
  return {
    sync: ({ begin, commit, markReady }) => {
      begin()
      commit()
      markReady()
      return () => {}
    },
  }
}

// Create collection options with all required handlers for testing
function createTestCollectionOptions<T extends object>(
  id: string,
  schema: StandardSchemaV1<T>,
  getKey: (item: T) => string
) {
  return {
    id,
    schema,
    getKey,
    sync: createTestSyncConfig<T>(),
    // Required handlers for direct mutations
    onInsert: async () => {},
    onUpdate: async () => {},
    onDelete: async () => {},
  }
}

describe(`TanStack DB Sync`, () => {
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

  describe(`changeToStateEvent`, () => {
    it(`should convert an insert change to a state event`, () => {
      const change: ChangeMessage<{ id: string; name: string }, string> = {
        key: `user-1`,
        value: { id: `user-1`, name: `Alice` },
        type: `insert`,
      }

      const event = changeToStateEvent(change, `user`, {
        primaryKeyField: `id`,
      })

      expect(event).toEqual({
        type: `user`,
        key: `user-1`,
        value: { name: `Alice` },
        headers: { operation: `insert` },
      })
    })

    it(`should convert an update change to a state event with old_value`, () => {
      const change: ChangeMessage<{ id: string; name: string }, string> = {
        key: `user-1`,
        value: { id: `user-1`, name: `Alice Updated` },
        previousValue: { id: `user-1`, name: `Alice` },
        type: `update`,
      }

      const event = changeToStateEvent(change, `user`, {
        primaryKeyField: `id`,
      })

      expect(event).toEqual({
        type: `user`,
        key: `user-1`,
        value: { name: `Alice Updated` },
        old_value: { name: `Alice` },
        headers: { operation: `update` },
      })
    })

    it(`should convert a delete change to a state event`, () => {
      const change: ChangeMessage<{ id: string; name: string }, string> = {
        key: `user-1`,
        value: { id: `user-1`, name: `Alice` },
        type: `delete`,
      }

      const event = changeToStateEvent(change, `user`, {
        primaryKeyField: `id`,
      })

      expect(event).toEqual({
        type: `user`,
        key: `user-1`,
        old_value: { name: `Alice` },
        headers: { operation: `delete` },
      })
    })

    it(`should include metadata in headers`, () => {
      const change: ChangeMessage<{ id: string; name: string }, string> = {
        key: `user-1`,
        value: { id: `user-1`, name: `Alice` },
        type: `insert`,
        metadata: { txid: `tx-123`, source: `api` },
      }

      const event = changeToStateEvent(change, `user`, {
        primaryKeyField: `id`,
      })

      expect(event.headers).toEqual({
        operation: `insert`,
        txid: `tx-123`,
        source: `api`,
      })
    })

    it(`should use transformHeaders to add custom headers`, () => {
      const change: ChangeMessage<{ id: string; name: string }, string> = {
        key: `user-1`,
        value: { id: `user-1`, name: `Alice` },
        type: `insert`,
      }

      const event = changeToStateEvent(change, `user`, {
        primaryKeyField: `id`,
        transformHeaders: () => ({
          timestamp: new Date().toISOString(),
          version: `1`,
        }),
      })

      expect(event.headers.timestamp).toBeDefined()
      expect(event.headers.version).toBe(`1`)
    })

    it(`should use transformValue to customize value`, () => {
      const change: ChangeMessage<
        { id: string; name: string; secret: string },
        string
      > = {
        key: `user-1`,
        value: { id: `user-1`, name: `Alice`, secret: `hidden` },
        type: `insert`,
      }

      const event = changeToStateEvent(change, `user`, {
        transformValue: (v) => ({ name: v.name }), // Exclude id and secret
      })

      expect(event.value).toEqual({ name: `Alice` })
    })

    it(`should handle numeric keys by converting to string`, () => {
      const change: ChangeMessage<{ id: number; name: string }, number> = {
        key: 42,
        value: { id: 42, name: `Item 42` },
        type: `insert`,
      }

      const event = changeToStateEvent(change, `item`, {})

      expect(event.key).toBe(`42`)
      expect(typeof event.key).toBe(`string`)
    })
  })

  describe(`changesToStateEvents`, () => {
    it(`should convert an array of changes`, () => {
      const changes: Array<
        ChangeMessage<{ id: string; name: string }, string>
      > = [
        { key: `1`, value: { id: `1`, name: `Alice` }, type: `insert` },
        { key: `2`, value: { id: `2`, name: `Bob` }, type: `insert` },
        {
          key: `1`,
          value: { id: `1`, name: `Alice Updated` },
          previousValue: { id: `1`, name: `Alice` },
          type: `update`,
        },
      ]

      const events = changesToStateEvents(changes, `user`, {
        primaryKeyField: `id`,
      })

      expect(events).toHaveLength(3)
      expect(events[0]?.headers.operation).toBe(`insert`)
      expect(events[1]?.headers.operation).toBe(`insert`)
      expect(events[2]?.headers.operation).toBe(`update`)
    })
  })

  describe(`syncCollectionToStream`, () => {
    it(`should sync collection changes to stream`, async () => {
      // Create a stream for testing
      const streamPath = `/sync/users-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })

      // Create a collection with sync config and handlers
      const users = createCollection(
        createTestCollectionOptions(
          `sync-test-users-${Date.now()}`,
          userSchema,
          (user) => user.id
        )
      )

      // Start syncing
      const subscription = syncCollectionToStream({
        collection: users,
        stream,
        entityType: `user`,
        primaryKeyField: `id`,
      })

      // Insert a user
      users.insert({ id: `user-1`, name: `Alice`, email: `alice@test.com` })

      // Wait a bit for the async append
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Read the stream to verify
      const reader = new DurableStream({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })
      const response = await reader.stream({ live: false })

      const items: Array<{ type: string; key: string }> = []
      response.subscribeJson((batch) => {
        for (const item of batch.items) {
          items.push(item as { type: string; key: string })
        }
      })

      // Wait for stream to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items[0]?.type).toBe(`user`)
      expect(items[0]?.key).toBe(`user-1`)

      // Cleanup
      subscription.unsubscribe()
    })

    it(`should handle includeInitialState option`, async () => {
      // Create a collection with sync config and handlers
      const users = createCollection(
        createTestCollectionOptions(
          `sync-test-users-initial-${Date.now()}`,
          userSchema,
          (user) => user.id
        )
      )

      // Create a stream for testing
      const streamPath = `/sync/users-initial-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })

      // Start syncing with initial state option
      // (Note: includeInitialState depends on TanStack DB's sync implementation)
      const subscription = syncCollectionToStream({
        collection: users,
        stream,
        entityType: `user`,
        primaryKeyField: `id`,
        includeInitialState: true,
      })

      // Insert after subscribing - should be captured
      users.insert({
        id: `user-1`,
        name: `Alice`,
        email: `alice@test.com`,
      })

      // Wait for the async append
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Read the stream to verify
      const reader = new DurableStream({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })
      const response = await reader.stream({ live: false })

      const items: Array<{ type: string; key: string }> = []
      response.subscribeJson((batch) => {
        for (const item of batch.items) {
          items.push(item as { type: string; key: string })
        }
      })

      // Wait for stream to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should have at least the insert
      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items[0]?.type).toBe(`user`)

      // Cleanup
      subscription.unsubscribe()
    })
  })

  describe(`syncCollectionsToStream`, () => {
    it(`should sync multiple collections to a single stream`, async () => {
      // Create collections with sync config and handlers
      const users = createCollection(
        createTestCollectionOptions(
          `sync-multi-users-${Date.now()}`,
          userSchema,
          (user) => user.id
        )
      )

      const messages = createCollection(
        createTestCollectionOptions(
          `sync-multi-messages-${Date.now()}`,
          messageSchema,
          (msg) => msg.id
        )
      )

      // Create a stream for testing
      const streamPath = `/sync/multi-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })

      // Start syncing both collections
      const subscription = syncCollectionsToStream({
        collections: {
          users: {
            collection: users,
            entityType: `user`,
            primaryKeyField: `id`,
          },
          messages: {
            collection: messages,
            entityType: `message`,
            primaryKeyField: `id`,
          },
        },
        stream,
      })

      // Insert data in both collections
      users.insert({ id: `user-1`, name: `Alice`, email: `alice@test.com` })
      messages.insert({
        id: `msg-1`,
        text: `Hello!`,
        userId: `user-1`,
      })

      // Wait for the async appends
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Read the stream to verify
      const reader = new DurableStream({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })
      const response = await reader.stream({ live: false })

      const items: Array<{ type: string; key: string }> = []
      response.subscribeJson((batch) => {
        for (const item of batch.items) {
          items.push(item as { type: string; key: string })
        }
      })

      // Wait for stream to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(items.length).toBeGreaterThanOrEqual(2)

      const types = items.map((i) => i.type)
      expect(types).toContain(`user`)
      expect(types).toContain(`message`)

      // Cleanup
      subscription.unsubscribe()
    })

    it(`should allow unsubscribing from all collections`, async () => {
      const users = createCollection(
        createTestCollectionOptions(
          `sync-unsub-users-${Date.now()}`,
          userSchema,
          (user) => user.id
        )
      )

      const messages = createCollection(
        createTestCollectionOptions(
          `sync-unsub-messages-${Date.now()}`,
          messageSchema,
          (msg) => msg.id
        )
      )

      const streamPath = `/sync/unsub-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })

      const subscription = syncCollectionsToStream({
        collections: {
          users: {
            collection: users,
            entityType: `user`,
            primaryKeyField: `id`,
          },
          messages: {
            collection: messages,
            entityType: `message`,
            primaryKeyField: `id`,
          },
        },
        stream,
      })

      // Unsubscribe
      subscription.unsubscribe()

      // Insert after unsubscribe - should not go to stream
      users.insert({ id: `user-after`, name: `After`, email: `after@test.com` })

      await new Promise((resolve) => setTimeout(resolve, 100))

      // Read the stream - should be empty
      const reader = new DurableStream({
        url: `${baseUrl}${streamPath}`,
        contentType: `application/json`,
      })
      const response = await reader.stream({ live: false })

      const items: Array<unknown> = []
      response.subscribeJson((batch) => {
        items.push(...batch.items)
      })

      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should have no items (unsubscribed before insert)
      expect(items.length).toBe(0)
    })
  })
})

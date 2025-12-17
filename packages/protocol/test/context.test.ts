import { describe, it, expect, beforeEach } from "vitest"
import { StreamStore } from "@durable-streams/server"
import { createStreamContext } from "../src/index"

describe(`ScopedStreamContext`, () => {
  let store: StreamStore

  beforeEach(() => {
    store = new StreamStore()
  })

  describe(`stream creation`, () => {
    it(`should create a stream within namespace`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      const info = await ctx.create(`doc-1`)

      expect(info.path).toBe(`/myns/doc-1`)
      expect(info.contentType).toBe(`application/json`)
      expect(store.has(`/myns/doc-1`)).toBe(true)
    })

    it(`should create stream with options`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      const info = await ctx.create(`doc-1`, {
        contentType: `application/octet-stream`,
        ttlSeconds: 3600,
        initialData: new Uint8Array([1, 2, 3]),
      })

      expect(info.path).toBe(`/myns/doc-1`)
      expect(info.ttlSeconds).toBe(3600)

      // Check initial data was written
      const stream = store.get(`/myns/doc-1`)
      expect(stream?.messages.length).toBeGreaterThan(0)
    })

    it(`should normalize subpaths`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      // Both should create the same stream
      await ctx.create(`/doc-1`)
      const exists = await ctx.has(`doc-1`)
      expect(exists).toBe(true)
    })

    it(`should call onStreamCreated hook`, async () => {
      let createdPath: string | undefined

      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
        onStreamCreated: async (info) => {
          createdPath = info.path
        },
      })

      await ctx.create(`doc-1`)
      expect(createdPath).toBe(`/myns/doc-1`)
    })
  })

  describe(`stream operations`, () => {
    it(`should get stream info`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      const info = await ctx.get(`doc-1`)

      expect(info).toBeTruthy()
      expect(info?.path).toBe(`/myns/doc-1`)
    })

    it(`should return undefined for non-existent stream`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      const info = await ctx.get(`nonexistent`)
      expect(info).toBeUndefined()
    })

    it(`should check stream existence`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      expect(await ctx.has(`doc-1`)).toBe(false)
      await ctx.create(`doc-1`)
      expect(await ctx.has(`doc-1`)).toBe(true)
    })

    it(`should append data to stream`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      const msg = await ctx.append(`doc-1`, { hello: `world` })

      expect(msg.offset).toBeTruthy()
      expect(msg.data.length).toBeGreaterThan(0)
    })

    it(`should append with different data types`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`, { contentType: `application/octet-stream` })

      // Uint8Array
      await ctx.append(`doc-1`, new Uint8Array([1, 2, 3]))

      // String
      await ctx.append(`doc-1`, `hello`)

      const result = await ctx.read(`doc-1`, { offset: `-1` })
      expect(result.messages.length).toBe(2)
    })

    it(`should read from stream`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      await ctx.append(`doc-1`, { msg: 1 })
      await ctx.append(`doc-1`, { msg: 2 })

      const result = await ctx.read(`doc-1`, { offset: `-1` })

      expect(result.messages.length).toBe(2)
      expect(result.upToDate).toBe(true)
      expect(result.nextOffset).toBeTruthy()
    })

    it(`should read from offset`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      const msg1 = await ctx.append(`doc-1`, { msg: 1 })
      await ctx.append(`doc-1`, { msg: 2 })

      const result = await ctx.read(`doc-1`, { offset: msg1.offset })

      expect(result.messages.length).toBe(1)
    })

    it(`should delete stream`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      expect(await ctx.has(`doc-1`)).toBe(true)

      await ctx.delete(`doc-1`)
      expect(await ctx.has(`doc-1`)).toBe(false)
    })

    it(`should call onStreamDeleted hook`, async () => {
      let deletedPath: string | undefined

      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
        onStreamDeleted: async (path) => {
          deletedPath = path
        },
      })

      await ctx.create(`doc-1`)
      await ctx.delete(`doc-1`)

      expect(deletedPath).toBe(`/myns/doc-1`)
    })
  })

  describe(`stream listing`, () => {
    it(`should list streams in namespace`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      await ctx.create(`doc-2`)
      await ctx.create(`other/nested`)

      const streams = await ctx.list()

      expect(streams.length).toBe(3)
      expect(streams.map((s) => s.path)).toContain(`/myns/doc-1`)
      expect(streams.map((s) => s.path)).toContain(`/myns/doc-2`)
    })

    it(`should filter by prefix`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`users/alice`)
      await ctx.create(`users/bob`)
      await ctx.create(`docs/readme`)

      const users = await ctx.list(`users`)

      expect(users.length).toBe(2)
      expect(users.every((s) => s.path.includes(`/users/`))).toBe(true)
    })

    it(`should not include streams from other namespaces`, async () => {
      const ctx1 = createStreamContext({
        namespace: `/ns1`,
        store,
      })
      const ctx2 = createStreamContext({
        namespace: `/ns2`,
        store,
      })

      await ctx1.create(`doc-1`)
      await ctx2.create(`doc-2`)

      const ns1Streams = await ctx1.list()
      const ns2Streams = await ctx2.list()

      expect(ns1Streams.length).toBe(1)
      expect(ns1Streams[0]?.path).toBe(`/ns1/doc-1`)

      expect(ns2Streams.length).toBe(1)
      expect(ns2Streams[0]?.path).toBe(`/ns2/doc-2`)
    })
  })

  describe(`namespace enforcement`, () => {
    it(`should prevent access outside namespace`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      // Create a stream in a different namespace directly
      store.create(`/other/doc`, { contentType: `application/json` })

      // Try to access it through the scoped context
      await expect(ctx.get(`../other/doc`)).rejects.toThrow(/outside namespace/)
    })

    it(`should normalize namespace path`, async () => {
      const ctx = createStreamContext({
        namespace: `myns/`,
        store,
      })

      expect(ctx.namespace).toBe(`/myns`)
    })
  })

  describe(`compaction`, () => {
    it(`should compact stream with multiple messages`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      await ctx.append(`doc-1`, { key: `a`, value: 1 })
      await ctx.append(`doc-1`, { key: `b`, value: 2 })
      await ctx.append(`doc-1`, { key: `a`, value: 3 })

      const result = await ctx.compact(`doc-1`, (messages) => {
        // Simple compaction: just take the last message data
        const decoder = new TextDecoder()
        const allData = messages.map((m) => decoder.decode(m.data)).join(``)
        return { compacted: true, originalCount: messages.length, data: allData }
      })

      expect(result).toBeTruthy()
      expect(result?.oldStream.path).toBe(`/myns/doc-1`)
      expect(result?.newStream.path).toContain(`compacted`)
    })

    it(`should not compact stream with single message`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      await ctx.append(`doc-1`, { only: `one` })

      const result = await ctx.compact(`doc-1`, () => ({ compacted: true }))

      expect(result).toBeUndefined()
    })
  })

  describe(`waiting for messages`, () => {
    it(`should wait for new messages`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      const msg = await ctx.append(`doc-1`, { initial: true })

      // Start waiting
      const waitPromise = ctx.waitForMessages(`doc-1`, msg.offset, 5000)

      // Append a new message after a delay
      setTimeout(async () => {
        await ctx.append(`doc-1`, { new: `message` })
      }, 50)

      const result = await waitPromise

      expect(result.timedOut).toBe(false)
      expect(result.messages.length).toBe(1)
    })

    it(`should timeout if no new messages`, async () => {
      const ctx = createStreamContext({
        namespace: `/myns`,
        store,
      })

      await ctx.create(`doc-1`)
      const msg = await ctx.append(`doc-1`, { initial: true })

      const result = await ctx.waitForMessages(`doc-1`, msg.offset, 50)

      expect(result.timedOut).toBe(true)
      expect(result.messages.length).toBe(0)
    })
  })
})

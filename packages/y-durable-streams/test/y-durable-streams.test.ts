import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { DurableStreamsProvider } from "../src"
import type { ProviderStatus, TransportMode } from "../src"

describe(`y-durable-streams`, () => {
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

  describe(`DurableStreamsProvider`, () => {
    let providers: Array<DurableStreamsProvider> = []

    afterEach(() => {
      // Clean up all providers created during tests
      for (const provider of providers) {
        provider.destroy()
      }
      providers = []
    })

    function createProvider(
      roomId: string,
      options?: {
        doc?: Y.Doc
        awareness?: boolean
        connect?: boolean
        transport?: TransportMode
        awarenessTransport?: TransportMode
      }
    ): DurableStreamsProvider {
      const doc = options?.doc ?? new Y.Doc()
      const awarenessProtocol = options?.awareness
        ? new Awareness(doc)
        : undefined
      const transport = options?.transport ?? `sse`

      const provider = new DurableStreamsProvider({
        doc,
        documentStream: {
          url: `${baseUrl}/v1/stream/rooms/${roomId}`,
          transport,
        },
        awarenessStream: awarenessProtocol
          ? {
              url: `${baseUrl}/v1/stream/presence/${roomId}`,
              protocol: awarenessProtocol,
              transport: options?.awarenessTransport ?? transport,
            }
          : undefined,
        connect: options?.connect,
      })

      providers.push(provider)
      return provider
    }

    function waitForSync(provider: DurableStreamsProvider): Promise<void> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Sync timeout`)),
          5000
        )

        if (provider.synced) {
          clearTimeout(timeout)
          resolve()
          return
        }

        const handler = (synced: boolean) => {
          if (synced) {
            provider.off(`synced`, handler)
            clearTimeout(timeout)
            resolve()
          }
        }
        provider.on(`synced`, handler)
      })
    }

    describe(`Connection lifecycle`, () => {
      it(`should auto-connect by default`, async () => {
        const roomId = `auto-connect-${Date.now()}`
        const provider = createProvider(roomId)

        await waitForSync(provider)

        expect(provider.connected).toBe(true)
        expect(provider.synced).toBe(true)
      })

      it(`should not auto-connect when connect: false`, async () => {
        const roomId = `no-auto-connect-${Date.now()}`
        const provider = createProvider(roomId, { connect: false })

        // Give it a moment to potentially connect
        await new Promise((r) => setTimeout(r, 100))

        expect(provider.connected).toBe(false)
        expect(provider.synced).toBe(false)
      })

      it(`should connect manually when connect: false`, async () => {
        const roomId = `manual-connect-${Date.now()}`
        const provider = createProvider(roomId, { connect: false })

        expect(provider.connected).toBe(false)

        await provider.connect()
        await waitForSync(provider)

        expect(provider.connected).toBe(true)
        expect(provider.synced).toBe(true)
      })

      it(`should disconnect and reconnect`, async () => {
        const roomId = `reconnect-${Date.now()}`
        const provider = createProvider(roomId)

        await waitForSync(provider)
        expect(provider.connected).toBe(true)

        provider.disconnect()
        expect(provider.connected).toBe(false)
        expect(provider.synced).toBe(false)

        await provider.connect()
        await waitForSync(provider)
        expect(provider.connected).toBe(true)
        expect(provider.synced).toBe(true)
      })

      it(`should emit status events`, async () => {
        const roomId = `status-events-${Date.now()}`
        const statuses: Array<ProviderStatus> = []

        const provider = createProvider(roomId, { connect: false })
        provider.on(`status`, (status: ProviderStatus) => statuses.push(status))

        await provider.connect()
        await waitForSync(provider)

        expect(statuses).toContain(`connecting`)
        expect(statuses).toContain(`connected`)

        provider.disconnect()
        expect(statuses).toContain(`disconnected`)
      })
    })

    describe(`Document synchronization`, () => {
      it(`should sync document between two providers`, async () => {
        const roomId = `sync-docs-${Date.now()}`

        // Provider 1 creates content
        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, { doc: doc1 })
        await waitForSync(provider1)

        const text1 = doc1.getText(`content`)
        text1.insert(0, `Hello from doc1`)

        // Wait for the update to be sent
        await new Promise((r) => setTimeout(r, 200))

        // Provider 2 joins and should receive the content
        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, { doc: doc2 })
        await waitForSync(provider2)

        const text2 = doc2.getText(`content`)
        expect(text2.toString()).toBe(`Hello from doc1`)
      })

      it(`should sync incremental updates`, async () => {
        const roomId = `incremental-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(roomId, { doc: doc1 })
        const provider2 = createProvider(roomId, { doc: doc2 })

        await waitForSync(provider1)
        await waitForSync(provider2)

        const text1 = doc1.getText(`content`)
        const text2 = doc2.getText(`content`)

        // Make changes in doc1
        text1.insert(0, `First`)

        // Wait for sync
        await new Promise((r) => setTimeout(r, 300))

        expect(text2.toString()).toBe(`First`)

        // Make more changes
        text1.insert(5, ` Second`)
        await new Promise((r) => setTimeout(r, 300))

        expect(text2.toString()).toBe(`First Second`)
      })

      it(`should handle concurrent edits`, async () => {
        const roomId = `concurrent-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(roomId, { doc: doc1 })
        const provider2 = createProvider(roomId, { doc: doc2 })

        await waitForSync(provider1)
        await waitForSync(provider2)

        // Ensure both start empty
        expect(doc1.getText(`content`).toString()).toBe(``)
        expect(doc2.getText(`content`).toString()).toBe(``)

        // Make concurrent edits
        doc1.getText(`content`).insert(0, `AAA`)
        doc2.getText(`content`).insert(0, `BBB`)

        // Wait for sync
        await new Promise((r) => setTimeout(r, 500))

        // Both should converge to the same state (CRDT property)
        const content1 = doc1.getText(`content`).toString()
        const content2 = doc2.getText(`content`).toString()

        expect(content1).toBe(content2)
        expect(content1).toContain(`AAA`)
        expect(content1).toContain(`BBB`)
      })
    })

    describe(`SSE transport with base64 encoding`, () => {
      it(`should sync document between two providers using SSE`, async () => {
        const roomId = `sse-sync-${Date.now()}`

        // Provider 1 creates content using SSE transport
        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, {
          doc: doc1,
          transport: `sse`,
        })
        await waitForSync(provider1)

        const text1 = doc1.getText(`content`)
        text1.insert(0, `Hello from SSE doc1`)

        // Wait for the update to be sent
        await new Promise((r) => setTimeout(r, 200))

        // Provider 2 joins using SSE and should receive the content
        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, {
          doc: doc2,
          transport: `sse`,
        })
        await waitForSync(provider2)

        const text2 = doc2.getText(`content`)
        expect(text2.toString()).toBe(`Hello from SSE doc1`)
      })

      it(`should sync incremental updates using SSE`, async () => {
        const roomId = `sse-incremental-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(roomId, {
          doc: doc1,
          transport: `sse`,
        })
        const provider2 = createProvider(roomId, {
          doc: doc2,
          transport: `sse`,
        })

        await waitForSync(provider1)
        await waitForSync(provider2)

        const text1 = doc1.getText(`content`)
        const text2 = doc2.getText(`content`)

        // Make changes in doc1
        text1.insert(0, `First`)

        // Wait for sync
        await new Promise((r) => setTimeout(r, 300))

        expect(text2.toString()).toBe(`First`)

        // Make more changes
        text1.insert(5, ` Second`)
        await new Promise((r) => setTimeout(r, 300))

        expect(text2.toString()).toBe(`First Second`)
      })

      it(`should handle concurrent edits using SSE`, async () => {
        const roomId = `sse-concurrent-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(roomId, {
          doc: doc1,
          transport: `sse`,
        })
        const provider2 = createProvider(roomId, {
          doc: doc2,
          transport: `sse`,
        })

        await waitForSync(provider1)
        await waitForSync(provider2)

        // Ensure both start empty
        expect(doc1.getText(`content`).toString()).toBe(``)
        expect(doc2.getText(`content`).toString()).toBe(``)

        // Make concurrent edits
        doc1.getText(`content`).insert(0, `AAA`)
        doc2.getText(`content`).insert(0, `BBB`)

        // Wait for sync
        await new Promise((r) => setTimeout(r, 500))

        // Both should converge to the same state (CRDT property)
        const content1 = doc1.getText(`content`).toString()
        const content2 = doc2.getText(`content`).toString()

        expect(content1).toBe(content2)
        expect(content1).toContain(`AAA`)
        expect(content1).toContain(`BBB`)
      })

      it(`should sync Y.Map using SSE`, async () => {
        const roomId = `sse-map-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, {
          doc: doc1,
          transport: `sse`,
        })
        await waitForSync(provider1)

        const map1 = doc1.getMap(`settings`)
        map1.set(`theme`, `dark`)
        map1.set(`fontSize`, 14)

        await new Promise((r) => setTimeout(r, 200))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, {
          doc: doc2,
          transport: `sse`,
        })
        await waitForSync(provider2)

        const map2 = doc2.getMap(`settings`)
        expect(map2.get(`theme`)).toBe(`dark`)
        expect(map2.get(`fontSize`)).toBe(14)
      })

      it(`should handle reconnect and disconnect with SSE`, async () => {
        const roomId = `sse-reconnect-${Date.now()}`
        const provider = createProvider(roomId, { transport: `sse` })

        await waitForSync(provider)
        expect(provider.connected).toBe(true)

        provider.disconnect()
        expect(provider.connected).toBe(false)
        expect(provider.synced).toBe(false)

        await provider.connect()
        await waitForSync(provider)
        expect(provider.connected).toBe(true)
        expect(provider.synced).toBe(true)
      })
    })

    describe(`Y.Map and Y.Array support`, () => {
      it(`should sync Y.Map`, async () => {
        const roomId = `map-sync-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, { doc: doc1 })
        await waitForSync(provider1)

        const map1 = doc1.getMap(`settings`)
        map1.set(`theme`, `dark`)
        map1.set(`fontSize`, 14)

        await new Promise((r) => setTimeout(r, 200))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, { doc: doc2 })
        await waitForSync(provider2)

        const map2 = doc2.getMap(`settings`)
        expect(map2.get(`theme`)).toBe(`dark`)
        expect(map2.get(`fontSize`)).toBe(14)
      })

      it(`should sync Y.Array`, async () => {
        const roomId = `array-sync-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, { doc: doc1 })
        await waitForSync(provider1)

        const array1 = doc1.getArray(`items`)
        array1.push([`item1`, `item2`, `item3`])

        await new Promise((r) => setTimeout(r, 200))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, { doc: doc2 })
        await waitForSync(provider2)

        const array2 = doc2.getArray(`items`)
        expect(array2.toArray()).toEqual([`item1`, `item2`, `item3`])
      })
    })

    describe(`Error handling`, () => {
      it(`should emit error event on failure`, async () => {
        const doc = new Y.Doc()

        const errors: Array<Error> = []
        const provider = new DurableStreamsProvider({
          doc,
          documentStream: {
            url: `http://localhost:99999/invalid`, // Invalid port
            transport: `sse`,
          },
          connect: false,
        })
        providers.push(provider)

        provider.on(`error`, (err: Error) => errors.push(err))

        // This should fail to connect
        await provider.connect().catch(() => {})

        // Give it time to emit the error
        await new Promise((r) => setTimeout(r, 200))

        // Should have received an error
        expect(errors.length).toBeGreaterThan(0)
      })
    })

    describe(`Destroy`, () => {
      it(`should clean up on destroy`, async () => {
        const roomId = `destroy-${Date.now()}`
        const doc = new Y.Doc()

        const provider = createProvider(roomId, { doc, awareness: true })
        await waitForSync(provider)

        expect(provider.connected).toBe(true)

        provider.destroy()

        expect(provider.connected).toBe(false)
        expect(provider.synced).toBe(false)
      })
    })
  })
})

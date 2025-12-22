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
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { DurableStreamsProvider, frameUpdate, parseFramedUpdates } from "../src"
import type { ProviderStatus } from "../src"

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

  describe(`Framing utilities`, () => {
    it(`should frame and parse a single update`, () => {
      const original = new Uint8Array([1, 2, 3, 4, 5])
      const framed = frameUpdate(original)

      // VarUint uses 1 byte for lengths < 128, so 1 + 5 = 6 bytes
      expect(framed.length).toBe(1 + original.length)

      const parsed = [...parseFramedUpdates(framed)]
      expect(parsed.length).toBe(1)
      expect(parsed[0]).toEqual(original)
    })

    it(`should frame and parse multiple updates`, () => {
      const update1 = new Uint8Array([1, 2, 3])
      const update2 = new Uint8Array([4, 5, 6, 7])
      const update3 = new Uint8Array([8])

      const framed1 = frameUpdate(update1)
      const framed2 = frameUpdate(update2)
      const framed3 = frameUpdate(update3)

      // Concatenate all framed updates
      const combined = new Uint8Array(
        framed1.length + framed2.length + framed3.length
      )
      combined.set(framed1, 0)
      combined.set(framed2, framed1.length)
      combined.set(framed3, framed1.length + framed2.length)

      const parsed = [...parseFramedUpdates(combined)]
      expect(parsed.length).toBe(3)
      expect(parsed[0]).toEqual(update1)
      expect(parsed[1]).toEqual(update2)
      expect(parsed[2]).toEqual(update3)
    })

    it(`should handle empty data`, () => {
      const parsed = [...parseFramedUpdates(new Uint8Array(0))]
      expect(parsed.length).toBe(0)
    })

    it(`should handle incomplete frames gracefully`, () => {
      // VarUint encoding: first byte is 10 (length), but only 3 bytes follow instead of 10
      const incomplete = new Uint8Array([10, 1, 2, 3])

      const consoleSpy = vi.spyOn(console, `error`).mockImplementation(() => {})
      const parsed = [...parseFramedUpdates(incomplete)]
      expect(parsed.length).toBe(0)
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
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
      }
    ): DurableStreamsProvider {
      const doc = options?.doc ?? new Y.Doc()
      const awarenessProtocol = options?.awareness
        ? new Awareness(doc)
        : undefined

      const provider = new DurableStreamsProvider({
        doc,
        documentStream: {
          url: `${baseUrl}/v1/stream/rooms/${roomId}`,
        },
        awarenessStream: awarenessProtocol
          ? {
              url: `${baseUrl}/v1/streams/presence/${roomId}`,
              protocol: awarenessProtocol,
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

    describe(`Awareness (presence) - Binary Format`, () => {
      it(`should sync awareness between providers`, async () => {
        const roomId = `awareness-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, { doc: doc1, awareness: true })
        await waitForSync(provider1)

        // Set local awareness state
        provider1.awareness!.setLocalStateField(`user`, {
          name: `Alice`,
          color: `#ff0000`,
        })

        await new Promise((r) => setTimeout(r, 300))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, { doc: doc2, awareness: true })
        await waitForSync(provider2)

        // Wait for awareness to sync
        await new Promise((r) => setTimeout(r, 500))

        const states = provider2.awareness!.getStates()
        const client1State = states.get(provider1.awareness!.clientID)

        expect(client1State).toBeDefined()
        expect(client1State?.user).toEqual({
          name: `Alice`,
          color: `#ff0000`,
        })
      })

      it(`should sync awareness with complex state objects`, async () => {
        const roomId = `awareness-complex-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, { doc: doc1, awareness: true })
        await waitForSync(provider1)

        // Set complex awareness state with nested objects
        provider1.awareness!.setLocalStateField(`user`, {
          name: `Bob`,
          color: `#00ff00`,
        })
        provider1.awareness!.setLocalStateField(`cursor`, {
          x: 100,
          y: 200,
          selection: { start: 0, end: 10 },
        })

        await new Promise((r) => setTimeout(r, 300))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, { doc: doc2, awareness: true })
        await waitForSync(provider2)

        await new Promise((r) => setTimeout(r, 500))

        const states = provider2.awareness!.getStates()
        const client1State = states.get(provider1.awareness!.clientID)

        expect(client1State).toBeDefined()
        expect(client1State?.user).toEqual({
          name: `Bob`,
          color: `#00ff00`,
        })
        expect(client1State?.cursor).toEqual({
          x: 100,
          y: 200,
          selection: { start: 0, end: 10 },
        })
      })

      it(`should handle awareness updates from multiple clients`, async () => {
        const roomId = `awareness-multi-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()
        const doc3 = new Y.Doc()

        const provider1 = createProvider(roomId, { doc: doc1, awareness: true })
        const provider2 = createProvider(roomId, { doc: doc2, awareness: true })

        await waitForSync(provider1)
        await waitForSync(provider2)

        // Set awareness for both clients
        provider1.awareness!.setLocalStateField(`user`, { name: `Client1` })
        provider2.awareness!.setLocalStateField(`user`, { name: `Client2` })

        await new Promise((r) => setTimeout(r, 500))

        // Third client joins and should see both awareness states
        const provider3 = createProvider(roomId, { doc: doc3, awareness: true })
        await waitForSync(provider3)

        await new Promise((r) => setTimeout(r, 500))

        const states = provider3.awareness!.getStates()

        // Should see at least its own state plus both other clients
        expect(states.size).toBeGreaterThanOrEqual(2)

        const client1State = states.get(provider1.awareness!.clientID)
        const client2State = states.get(provider2.awareness!.clientID)

        expect(client1State?.user).toEqual({ name: `Client1` })
        expect(client2State?.user).toEqual({ name: `Client2` })
      })

      it(`should update awareness state changes in real-time`, async () => {
        const roomId = `awareness-realtime-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(roomId, { doc: doc1, awareness: true })
        const provider2 = createProvider(roomId, { doc: doc2, awareness: true })

        await waitForSync(provider1)
        await waitForSync(provider2)

        // Initial state
        provider1.awareness!.setLocalStateField(`user`, { name: `Initial` })
        await new Promise((r) => setTimeout(r, 300))

        let client1State = provider2
          .awareness!.getStates()
          .get(provider1.awareness!.clientID)
        expect(client1State?.user).toEqual({ name: `Initial` })

        // Update state
        provider1.awareness!.setLocalStateField(`user`, { name: `Updated` })
        await new Promise((r) => setTimeout(r, 300))

        client1State = provider2
          .awareness!.getStates()
          .get(provider1.awareness!.clientID)
        expect(client1State?.user).toEqual({ name: `Updated` })
      })

      it(`should handle binary awareness data with special characters in state`, async () => {
        const roomId = `awareness-special-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(roomId, { doc: doc1, awareness: true })
        await waitForSync(provider1)

        // Set state with special characters and unicode
        provider1.awareness!.setLocalStateField(`user`, {
          name: `User 日本語 🎉`,
          emoji: `👍🏻`,
          special: `"quotes" and 'apostrophes' & <html>`,
        })

        await new Promise((r) => setTimeout(r, 300))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(roomId, { doc: doc2, awareness: true })
        await waitForSync(provider2)

        await new Promise((r) => setTimeout(r, 500))

        const states = provider2.awareness!.getStates()
        const client1State = states.get(provider1.awareness!.clientID)

        expect(client1State).toBeDefined()
        expect(client1State?.user).toEqual({
          name: `User 日本語 🎉`,
          emoji: `👍🏻`,
          special: `"quotes" and 'apostrophes' & <html>`,
        })
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

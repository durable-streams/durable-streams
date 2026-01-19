/**
 * Yjs Durable Streams Protocol Conformance Tests
 *
 * These tests verify the Yjs protocol implementation by:
 * 1. Starting a durable streams server (underlying storage)
 * 2. Starting a Yjs server (protocol layer)
 * 3. Testing various scenarios with the YjsProvider
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { YjsProvider } from "../src"
import { YjsServer } from "../src/server"

describe(`Yjs Durable Streams Protocol`, () => {
  let dsServer: DurableStreamTestServer
  let yjsServer: YjsServer
  let baseUrl: string

  beforeAll(async () => {
    // Start durable streams server
    dsServer = new DurableStreamTestServer({ port: 0 })
    await dsServer.start()

    // Start Yjs server connected to DS server
    yjsServer = new YjsServer({
      port: 0,
      dsServerUrl: dsServer.url,
      compactionThreshold: 1024, // Low threshold for testing (1KB)
      minUpdatesBeforeCompaction: 3, // Low count for testing
    })
    await yjsServer.start()

    baseUrl = `${yjsServer.url}/v1/yjs/test`
  })

  afterAll(async () => {
    // Stop both servers - don't wait for graceful shutdown
    // (long-poll connections may keep them busy)
    yjsServer.stop().catch(() => {})
    dsServer.stop().catch(() => {})
    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 200))
  }, 5000)

  describe(`Document Operations`, () => {
    let providers: Array<YjsProvider> = []

    afterEach(() => {
      for (const provider of providers) {
        provider.destroy()
      }
      providers = []
    })

    function createProvider(
      docId: string,
      options?: {
        doc?: Y.Doc
        awareness?: Awareness
        connect?: boolean
      }
    ): YjsProvider {
      const doc = options?.doc ?? new Y.Doc()

      const provider = new YjsProvider({
        doc,
        baseUrl,
        docId,
        awareness: options?.awareness,
        connect: options?.connect,
      })

      providers.push(provider)
      return provider
    }

    function waitForSync(provider: YjsProvider): Promise<void> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Sync timeout`)),
          10000
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

    describe(`index.new-document`, () => {
      it(`should return default index for new document`, async () => {
        const docId = `new-doc-${Date.now()}`
        const provider = createProvider(docId)

        await waitForSync(provider)

        expect(provider.connected).toBe(true)
        expect(provider.synced).toBe(true)
      })
    })

    describe(`write.creates-document`, () => {
      it(`should create document on first write`, async () => {
        const docId = `create-on-write-${Date.now()}`
        const doc = new Y.Doc()
        const provider = createProvider(docId, { doc })

        await waitForSync(provider)

        // Make a change
        const text = doc.getText(`content`)
        text.insert(0, `Hello World`)

        // Wait for sync
        await new Promise((r) => setTimeout(r, 500))
        expect(provider.synced).toBe(true)
      })
    })

    describe(`updates.read-from-offset`, () => {
      it(`should sync document between two providers`, async () => {
        const docId = `sync-${Date.now()}`

        // Provider 1 creates content
        const doc1 = new Y.Doc()
        const provider1 = createProvider(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text1 = doc1.getText(`content`)
        text1.insert(0, `Hello from doc1`)

        // Wait for the update to be sent
        await new Promise((r) => setTimeout(r, 500))

        // Provider 2 joins and should receive the content
        const doc2 = new Y.Doc()
        const provider2 = createProvider(docId, { doc: doc2 })
        await waitForSync(provider2)

        const text2 = doc2.getText(`content`)
        expect(text2.toString()).toBe(`Hello from doc1`)
      })
    })

    describe(`updates.live-polling`, () => {
      it(`should receive live updates via long-poll`, async () => {
        const docId = `live-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(docId, { doc: doc1 })
        const provider2 = createProvider(docId, { doc: doc2 })

        await waitForSync(provider1)
        await waitForSync(provider2)

        const text1 = doc1.getText(`content`)
        const text2 = doc2.getText(`content`)

        // Make changes in doc1
        text1.insert(0, `First`)

        // Wait for live sync
        await new Promise((r) => setTimeout(r, 500))

        expect(text2.toString()).toBe(`First`)

        // Make more changes
        text1.insert(5, ` Second`)
        await new Promise((r) => setTimeout(r, 500))

        expect(text2.toString()).toBe(`First Second`)
      })
    })

    describe(`Concurrent edits`, () => {
      it(`should handle concurrent edits with CRDT convergence`, async () => {
        const docId = `concurrent-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(docId, { doc: doc1 })
        const provider2 = createProvider(docId, { doc: doc2 })

        await waitForSync(provider1)
        await waitForSync(provider2)

        // Ensure both start empty
        expect(doc1.getText(`content`).toString()).toBe(``)
        expect(doc2.getText(`content`).toString()).toBe(``)

        // Make concurrent edits
        doc1.getText(`content`).insert(0, `AAA`)
        doc2.getText(`content`).insert(0, `BBB`)

        // Wait for sync
        await new Promise((r) => setTimeout(r, 1000))

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
        const docId = `map-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(docId, { doc: doc1 })
        await waitForSync(provider1)

        const map1 = doc1.getMap(`settings`)
        map1.set(`theme`, `dark`)
        map1.set(`fontSize`, 14)

        await new Promise((r) => setTimeout(r, 500))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(docId, { doc: doc2 })
        await waitForSync(provider2)

        const map2 = doc2.getMap(`settings`)
        expect(map2.get(`theme`)).toBe(`dark`)
        expect(map2.get(`fontSize`)).toBe(14)
      })

      it(`should sync Y.Array`, async () => {
        const docId = `array-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(docId, { doc: doc1 })
        await waitForSync(provider1)

        const array1 = doc1.getArray(`items`)
        array1.push([`item1`, `item2`, `item3`])

        await new Promise((r) => setTimeout(r, 500))

        const doc2 = new Y.Doc()
        const provider2 = createProvider(docId, { doc: doc2 })
        await waitForSync(provider2)

        const array2 = doc2.getArray(`items`)
        expect(array2.toArray()).toEqual([`item1`, `item2`, `item3`])
      })
    })
  })

  describe(`Presence`, () => {
    let providers: Array<YjsProvider> = []

    afterEach(() => {
      for (const provider of providers) {
        provider.destroy()
      }
      providers = []
    })

    function createProvider(
      docId: string,
      options?: {
        doc?: Y.Doc
        awareness?: Awareness
      }
    ): YjsProvider {
      const doc = options?.doc ?? new Y.Doc()
      const awareness = options?.awareness ?? new Awareness(doc)

      const provider = new YjsProvider({
        doc,
        baseUrl,
        docId,
        awareness,
      })

      providers.push(provider)
      return provider
    }

    function waitForSync(provider: YjsProvider): Promise<void> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Sync timeout`)),
          10000
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

    describe(`presence.broadcast`, () => {
      it(`should sync awareness between providers`, async () => {
        const docId = `awareness-${Date.now()}`

        const doc1 = new Y.Doc()
        const awareness1 = new Awareness(doc1)
        const provider1 = createProvider(docId, {
          doc: doc1,
          awareness: awareness1,
        })
        await waitForSync(provider1)

        const doc2 = new Y.Doc()
        const awareness2 = new Awareness(doc2)
        const provider2 = createProvider(docId, {
          doc: doc2,
          awareness: awareness2,
        })
        await waitForSync(provider2)

        // Both providers are now connected and polling.
        // Set awareness state AFTER both are listening - this ensures
        // provider2's presence poll will see it.
        await new Promise((r) => setTimeout(r, 200))

        awareness1.setLocalStateField(`user`, {
          name: `Alice`,
          color: `#ff0000`,
        })

        // Wait for awareness to sync
        await new Promise((r) => setTimeout(r, 1500))

        const states = awareness2.getStates()
        const client1State = states.get(awareness1.clientID)

        expect(client1State).toBeDefined()
        expect(client1State?.user).toEqual({
          name: `Alice`,
          color: `#ff0000`,
        })
      })
    })
  })

  describe(`Compaction`, () => {
    let providers: Array<YjsProvider> = []

    afterEach(() => {
      for (const provider of providers) {
        provider.destroy()
      }
      providers = []
    })

    function createProvider(
      docId: string,
      options?: {
        doc?: Y.Doc
      }
    ): YjsProvider {
      const doc = options?.doc ?? new Y.Doc()

      const provider = new YjsProvider({
        doc,
        baseUrl,
        docId,
      })

      providers.push(provider)
      return provider
    }

    function waitForSync(provider: YjsProvider): Promise<void> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Sync timeout`)),
          10000
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

    describe(`compaction.client-transparent`, () => {
      it(`should sync correctly through compaction`, async () => {
        const docId = `compaction-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)

        // Write enough data to trigger compaction (threshold is 1KB)
        // Each update with lib0 framing is roughly the string length + overhead
        for (let i = 0; i < 10; i++) {
          text.insert(text.length, `X`.repeat(200)) // 200 bytes each
          await new Promise((r) => setTimeout(r, 100))
        }

        // Wait for potential compaction
        await new Promise((r) => setTimeout(r, 1000))

        // Second provider should be able to sync even if compaction happened
        const doc2 = new Y.Doc()
        const provider2 = createProvider(docId, { doc: doc2 })
        await waitForSync(provider2)

        const text2 = doc2.getText(`content`)
        expect(text2.toString()).toBe(text.toString())
        expect(text2.toString().length).toBe(2000) // 10 * 200 chars
      })
    })
  })

  describe(`Error Handling`, () => {
    let providers: Array<YjsProvider> = []

    afterEach(() => {
      for (const provider of providers) {
        provider.destroy()
      }
      providers = []
    })

    describe(`error.invalid-doc-id`, () => {
      it(`should handle connect/disconnect cycle`, async () => {
        const docId = `reconnect-${Date.now()}`
        const doc = new Y.Doc()

        const provider = new YjsProvider({
          doc,
          baseUrl,
          docId,
          connect: false,
        })
        providers.push(provider)

        expect(provider.connected).toBe(false)

        await provider.connect()
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Sync timeout`)),
            10000
          )

          if (provider.synced) {
            clearTimeout(timeout)
            resolve(undefined)
            return
          }

          const handler = (synced: boolean) => {
            if (synced) {
              provider.off(`synced`, handler)
              clearTimeout(timeout)
              resolve(undefined)
            }
          }
          provider.on(`synced`, handler)
        })

        expect(provider.connected).toBe(true)

        provider.disconnect()
        expect(provider.connected).toBe(false)

        await provider.connect()
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Sync timeout`)),
            10000
          )

          if (provider.synced) {
            clearTimeout(timeout)
            resolve(undefined)
            return
          }

          const handler = (synced: boolean) => {
            if (synced) {
              provider.off(`synced`, handler)
              clearTimeout(timeout)
              resolve(undefined)
            }
          }
          provider.on(`synced`, handler)
        })

        expect(provider.connected).toBe(true)
      })
    })
  })
})

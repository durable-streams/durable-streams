/**
 * Yjs Durable Streams Protocol Conformance Tests
 *
 * These tests verify the Yjs protocol implementation by:
 * 1. Starting a durable streams server (underlying storage)
 * 2. Starting a Yjs server (protocol layer)
 * 3. Testing various scenarios with the YjsProvider
 */

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
import { DurableStream } from "@durable-streams/client"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { YjsProvider } from "../src"
import { YjsServer } from "../src/server"
import type { YjsIndex } from "../src/server/types"

const DEFAULT_TIMEOUT_MS = 10000
const POLL_INTERVAL_MS = 50

async function waitForCondition(
  condition: () => boolean,
  options: {
    timeoutMs?: number
    intervalMs?: number
    label?: string
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(
    options.label
      ? `Timeout waiting for ${options.label}`
      : `Timeout waiting for condition`
  )
}

function waitForSync(
  provider: YjsProvider,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Sync timeout`)),
      timeoutMs
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

async function waitForDocText(
  doc: Y.Doc,
  name: string,
  expected: string
): Promise<void> {
  await waitForCondition(() => doc.getText(name).toString() === expected, {
    label: `doc text ${name} to be "${expected}"`,
  })
}

async function waitForAwarenessState(
  awareness: Awareness,
  clientId: number,
  predicate: (state: unknown | undefined) => boolean,
  label: string
): Promise<void> {
  await waitForCondition(
    () => {
      const state = awareness.getStates().get(clientId)
      return predicate(state)
    },
    { label }
  )
}

async function ensureAwarenessDelivery(
  sender: Awareness,
  receiver: Awareness,
  update: { key: string; value: unknown },
  predicate: (state: unknown | undefined) => boolean,
  label: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    sender.setLocalStateField(update.key, update.value)
    const state = receiver.getStates().get(sender.clientID)
    if (predicate(state)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Timeout waiting for ${label}`)
}

async function fetchIndexEntries(
  baseUrl: string,
  docId: string
): Promise<Array<YjsIndex>> {
  const stream = new DurableStream({
    url: `${baseUrl}/docs/${docId}/index`,
    contentType: `application/json`,
  })
  const response = await stream.stream({ offset: `-1` })
  return response.json<YjsIndex>()
}

async function waitForIndexEntries(
  baseUrl: string,
  docId: string,
  expectedLength: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Array<YjsIndex>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const entries = await fetchIndexEntries(baseUrl, docId)
    if (entries.length >= expectedLength) return entries
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error(`Timeout waiting for ${expectedLength} index entries`)
}

async function fetchLatestIndex(
  baseUrl: string,
  docId: string
): Promise<YjsIndex> {
  const entries = await fetchIndexEntries(baseUrl, docId)
  if (entries.length === 0) {
    throw new Error(`Index is empty`)
  }
  return entries[entries.length - 1]!
}

async function appendWithSync(
  provider: YjsProvider,
  text: Y.Text,
  chunk: string,
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    text.insert(text.length, chunk)
    await waitForCondition(() => provider.synced, {
      timeoutMs: 3000,
      label: `provider sync after update`,
    })
  }
}

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
      compactionThreshold: 1500, // Threshold for testing (~7 updates)
      minUpdatesBeforeCompaction: 5, // Min count for testing
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

        await waitForCondition(() => provider.synced, {
          label: `provider synced after write`,
        })
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

        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after update`,
        })

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
        doc2.getText(`content`) // Ensure text type exists

        // Make changes in doc1
        text1.insert(0, `First`)

        await waitForDocText(doc2, `content`, `First`)

        // Make more changes
        text1.insert(5, ` Second`)
        await waitForDocText(doc2, `content`, `First Second`)
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

        await waitForCondition(
          () => {
            const content1 = doc1.getText(`content`).toString()
            const content2 = doc2.getText(`content`).toString()
            return (
              content1 === content2 &&
              content1.includes(`AAA`) &&
              content1.includes(`BBB`)
            )
          },
          { label: `concurrent edits converge` }
        )

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

        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after map updates`,
        })

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

        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after array updates`,
        })

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

        await ensureAwarenessDelivery(
          awareness2,
          awareness1,
          {
            key: `user`,
            value: { name: `Bob`, color: `#00aa00` },
          },
          (state) =>
            (state as { user?: { name?: string } } | undefined)?.user?.name ===
            `Bob`,
          `provider1 sees provider2 awareness`
        )

        await ensureAwarenessDelivery(
          awareness1,
          awareness2,
          {
            key: `user`,
            value: { name: `Alice`, color: `#ff0000` },
          },
          (state) =>
            (state as { user?: { name?: string } } | undefined)?.user?.name ===
            `Alice`,
          `provider2 sees provider1 awareness`
        )

        const client1State = awareness2.getStates().get(awareness1.clientID)

        expect(client1State).toBeDefined()
        expect(client1State?.user).toEqual({
          name: `Alice`,
          color: `#ff0000`,
        })
      })
    })

    describe(`presence.cleanup`, () => {
      it(`should remove awareness state after disconnect`, async () => {
        const docId = `awareness-cleanup-${Date.now()}`

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

        awareness1.setLocalStateField(`user`, { name: `Alice` })
        await waitForAwarenessState(
          awareness2,
          awareness1.clientID,
          (state) => Boolean((state as { user?: object } | undefined)?.user),
          `provider2 sees provider1 awareness`
        )

        provider1.destroy()

        await waitForAwarenessState(
          awareness2,
          awareness1.clientID,
          (state) => state === undefined,
          `provider2 observes provider1 removal`
        )
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

    describe(`compaction.client-transparent`, () => {
      it(`should sync correctly through compaction`, async () => {
        const docId = `compaction-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)

        // Write enough data to trigger compaction (threshold is 1KB)
        // Each update with lib0 framing is roughly the string length + overhead
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        await waitForIndexEntries(baseUrl, docId, 2)

        // Second provider should be able to sync even if compaction happened
        const doc2 = new Y.Doc()
        const provider2 = createProvider(docId, { doc: doc2 })
        await waitForSync(provider2)

        const text2 = doc2.getText(`content`)
        expect(text2.toString()).toBe(text.toString())
        expect(text2.toString().length).toBe(2000) // 10 * 200 chars
      })
    })

    describe(`compaction.post-update`, () => {
      it(`should include updates written after compaction`, async () => {
        const docId = `compaction-post-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        await waitForIndexEntries(baseUrl, docId, 2)

        text.insert(text.length, `POST`)
        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after post-compaction update`,
        })

        const expected = text.toString()

        const doc2 = new Y.Doc()
        const provider2 = createProvider(docId, { doc: doc2 })
        await waitForSync(provider2)

        await waitForDocText(doc2, `content`, expected)
      })
    })

    describe(`compaction.live-streaming`, () => {
      it(`should continue streaming during compaction`, async () => {
        const docId = `compaction-live-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = createProvider(docId, { doc: doc1 })
        const provider2 = createProvider(docId, { doc: doc2 })

        await waitForSync(provider1)
        await waitForSync(provider2)

        const text = doc1.getText(`content`)
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        await waitForIndexEntries(baseUrl, docId, 2)

        text.insert(text.length, `AFTER`)
        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after live update`,
        })

        await waitForDocText(doc2, `content`, text.toString())
        expect(provider2.connected).toBe(true)
      })
    })

    describe(`compaction.concurrent-writes`, () => {
      it(`should avoid concurrent compactions and keep updates`, async () => {
        const docId = `compaction-concurrent-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = createProvider(docId, { doc: doc1 })
        await waitForSync(provider1)

        const compactor = (yjsServer as unknown as { compactor: unknown })
          .compactor as {
          performCompaction: (...args: Array<unknown>) => Promise<unknown>
        }

        const original = compactor.performCompaction.bind(compactor)
        let allowCompaction!: () => void
        let compactionStarted!: () => void

        const started = new Promise<void>((resolve) => {
          compactionStarted = resolve
        })
        const allow = new Promise<void>((resolve) => {
          allowCompaction = resolve
        })

        const spy = vi
          .spyOn(compactor, `performCompaction`)
          .mockImplementation(async (...args: Array<unknown>) => {
            compactionStarted()
            await allow
            return original(...args)
          })

        try {
          const text = doc1.getText(`content`)
          await appendWithSync(provider1, text, `X`.repeat(300), 6)

          await started

          await appendWithSync(provider1, text, `Y`.repeat(50), 3)

          allowCompaction()
          await waitForIndexEntries(baseUrl, docId, 2)

          expect(spy).toHaveBeenCalledTimes(1)

          const doc2 = new Y.Doc()
          const provider2 = createProvider(docId, { doc: doc2 })
          await waitForSync(provider2)

          await waitForDocText(doc2, `content`, text.toString())
        } finally {
          allowCompaction()
          spy.mockRestore()
        }
      })
    })

    describe(`compaction.stream-immutability`, () => {
      it(`should keep the same updates stream across compactions`, async () => {
        const docId = `compaction-stream-${Date.now()}`

        const doc = new Y.Doc()
        const provider = createProvider(docId, { doc })
        await waitForSync(provider)

        const text = doc.getText(`content`)
        await appendWithSync(provider, text, `A`.repeat(200), 10)
        await waitForIndexEntries(baseUrl, docId, 2)

        await appendWithSync(provider, text, `B`.repeat(200), 10)
        const entries = await waitForIndexEntries(baseUrl, docId, 3)

        const updatesStreams = new Set(
          entries.map((entry) => entry.updates_stream)
        )
        expect(updatesStreams.size).toBe(1)
      })
    })

    describe(`compaction.offset-format`, () => {
      it(`should store padded update offsets`, async () => {
        const docId = `offset-format-${Date.now()}`

        const doc = new Y.Doc()
        const provider = createProvider(docId, { doc })
        await waitForSync(provider)

        const text = doc.getText(`content`)
        await appendWithSync(provider, text, `X`.repeat(200), 10)
        await waitForIndexEntries(baseUrl, docId, 2)

        const latest = await fetchLatestIndex(baseUrl, docId)
        expect(latest.update_offset).toMatch(/^\d{16}_\d{16}$/)
      })
    })

    describe(`compaction.snapshot-exists`, () => {
      it(`should keep the referenced snapshot readable`, async () => {
        const docId = `snapshot-exists-${Date.now()}`

        const doc = new Y.Doc()
        const provider = createProvider(docId, { doc })
        await waitForSync(provider)

        const text = doc.getText(`content`)
        await appendWithSync(provider, text, `Z`.repeat(200), 10)
        await waitForIndexEntries(baseUrl, docId, 2)

        const latest = await fetchLatestIndex(baseUrl, docId)
        expect(latest.snapshot_stream).toBeTruthy()

        const snapshotStream = new DurableStream({
          url: `${baseUrl}/docs/${docId}/snapshots/${latest.snapshot_stream}`,
          contentType: `application/octet-stream`,
        })
        const response = await snapshotStream.stream({ offset: `-1` })
        const snapshot = await response.body()

        expect(snapshot.length).toBeGreaterThan(0)
      })
    })
  })

  describe(`Server Restart`, () => {
    it(`should preserve updates stream across restarts`, async () => {
      const docId = `restart-${Date.now()}`
      const service = `restart`

      const serverA = new YjsServer({
        port: 0,
        dsServerUrl: dsServer.url,
        compactionThreshold: 1500,
        minUpdatesBeforeCompaction: 5,
      })
      await serverA.start()

      const baseUrlA = `${serverA.url}/v1/yjs/${service}`
      const doc = new Y.Doc()
      const provider = new YjsProvider({
        doc,
        baseUrl: baseUrlA,
        docId,
      })

      let updatesStream: string | null = null

      try {
        await waitForSync(provider)

        const text = doc.getText(`content`)
        await appendWithSync(provider, text, `R`.repeat(200), 10)
        await waitForIndexEntries(baseUrlA, docId, 2)

        const latest = await fetchLatestIndex(baseUrlA, docId)
        updatesStream = latest.updates_stream
      } finally {
        provider.destroy()
        await serverA.stop()
      }

      const serverB = new YjsServer({
        port: 0,
        dsServerUrl: dsServer.url,
        compactionThreshold: 1500,
        minUpdatesBeforeCompaction: 5,
      })
      await serverB.start()

      const baseUrlB = `${serverB.url}/v1/yjs/${service}`

      try {
        const latest = await fetchLatestIndex(baseUrlB, docId)
        expect(latest.updates_stream).toBe(updatesStream)

        const doc2 = new Y.Doc()
        const provider2 = new YjsProvider({
          doc: doc2,
          baseUrl: baseUrlB,
          docId,
        })
        await waitForSync(provider2)
        provider2.destroy()
      } finally {
        await serverB.stop()
      }
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

    describe(`error.event-emission`, () => {
      it(`should emit error event on connection failure`, async () => {
        const doc = new Y.Doc()
        const errors: Array<Error> = []

        const provider = new YjsProvider({
          doc,
          baseUrl: `http://localhost:1`, // Invalid port - connection refused
          docId: `error-test-${Date.now()}`,
          connect: false,
        })
        providers.push(provider)

        provider.on(`error`, (err) => {
          errors.push(err)
        })

        // Connect will fail because the server doesn't exist
        await provider.connect()

        await waitForCondition(() => errors.length > 0, {
          label: `error event emitted`,
        })

        expect(errors.length).toBeGreaterThan(0)
        expect(errors[0]).toBeInstanceOf(Error)
      })
    })

    describe(`error.disconnect-during-sync`, () => {
      it(`should handle disconnect during initial sync`, async () => {
        const docId = `disconnect-sync-${Date.now()}`
        const doc = new Y.Doc()

        const provider = new YjsProvider({
          doc,
          baseUrl,
          docId,
          connect: false,
        })
        providers.push(provider)

        // Start connecting but disconnect immediately
        const connectPromise = provider.connect()
        provider.disconnect()

        // Should not throw
        await connectPromise

        expect(provider.connected).toBe(false)
      })

      it(`should handle disconnect while polling`, async () => {
        const docId = `disconnect-poll-${Date.now()}`
        const doc = new Y.Doc()

        const provider = new YjsProvider({
          doc,
          baseUrl,
          docId,
        })
        providers.push(provider)

        await waitForSync(provider)
        expect(provider.connected).toBe(true)

        // Disconnect while polling is active
        provider.disconnect()

        expect(provider.connected).toBe(false)
        expect(provider.synced).toBe(false)
      })
    })

    describe(`error.reconnect-after-error`, () => {
      it(`should be able to reconnect after disconnect`, async () => {
        const docId = `reconnect-error-${Date.now()}`
        const doc = new Y.Doc()

        const provider = new YjsProvider({
          doc,
          baseUrl,
          docId,
        })
        providers.push(provider)

        await waitForSync(provider)

        // Make some changes
        doc.getText(`content`).insert(0, `Before disconnect`)
        await waitForCondition(() => provider.synced, {
          label: `provider synced before disconnect`,
        })

        // Disconnect
        provider.disconnect()
        expect(provider.connected).toBe(false)

        // Reconnect
        await provider.connect()
        await waitForSync(provider)

        expect(provider.connected).toBe(true)
        expect(doc.getText(`content`).toString()).toBe(`Before disconnect`)
      })
    })

    describe(`error.connect-disconnect-cycle`, () => {
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
        await waitForSync(provider)

        expect(provider.connected).toBe(true)

        provider.disconnect()
        expect(provider.connected).toBe(false)

        await provider.connect()
        await waitForSync(provider)

        expect(provider.connected).toBe(true)
      })
    })
  })
})

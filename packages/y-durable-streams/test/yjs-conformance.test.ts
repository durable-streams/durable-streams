/**
 * Yjs Durable Streams Protocol Conformance Tests
 *
 * These tests verify the Yjs protocol implementation by:
 * 1. Starting a durable streams server (underlying storage)
 * 2. Starting a Yjs server (protocol layer)
 * 3. Testing various scenarios with the YjsProvider
 *
 * Protocol: https://github.com/durable-streams/durable-streams/blob/main/packages/y-durable-streams/PROTOCOL.md
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
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { YjsProvider } from "../src"
import { YjsServer } from "../src/server"

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

/**
 * Wait for a snapshot to exist by checking if offset=snapshot redirects to a _snapshot URL.
 */
async function waitForSnapshot(
  baseUrl: string,
  docId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${baseUrl}/docs/${docId}?offset=snapshot`, {
      method: `GET`,
      redirect: `manual`,
    })

    if (response.status === 307) {
      const location = response.headers.get(`location`)
      if (location && location.includes(`_snapshot`)) {
        // Extract the snapshot offset from the URL
        const match = location.match(/offset=([^&]+_snapshot)/)
        if (match) {
          return match[1]!
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error(`Timeout waiting for snapshot`)
}

/**
 * Create a document on the Yjs server via PUT.
 * Must be called before reading or writing to a document.
 */
async function createDocument(baseUrl: string, docId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/docs/${docId}`, {
    method: `PUT`,
  })

  if (response.status !== 201 && response.status !== 409) {
    throw new Error(
      `Failed to create document: ${response.status} ${await response.text()}`
    )
  }
}

/**
 * To run against an external Yjs server, set the YJS_CONFORMANCE_URL env var:
 *   YJS_CONFORMANCE_URL=http://localhost:4438/v1/yjs/test pnpm vitest run
 *
 * If not set, local test servers will be started automatically.
 */
const externalServerUrl = process.env.YJS_CONFORMANCE_URL

describe(`Yjs Durable Streams Protocol`, () => {
  let dsServer: DurableStreamTestServer | null = null
  let yjsServer: YjsServer | null = null
  let baseUrl: string

  beforeAll(async () => {
    if (externalServerUrl) {
      // Use external server - skip local server startup
      baseUrl = externalServerUrl
      console.log(`Using external Yjs server: ${baseUrl}`)
    } else {
      // Start local servers for testing
      dsServer = new DurableStreamTestServer({ port: 0 })
      await dsServer.start()

      yjsServer = new YjsServer({
        port: 0,
        dsServerUrl: dsServer.url,
        compactionThreshold: 1500, // Threshold for testing (~7 updates)
        minUpdatesBeforeCompaction: 5, // Min count for testing
      })
      await yjsServer.start()

      baseUrl = `${yjsServer.url}/v1/yjs/test`
    }
  })

  afterAll(async () => {
    // Stop local servers if we started them
    if (yjsServer) {
      yjsServer.stop().catch(() => {})
    }
    if (dsServer) {
      dsServer.stop().catch(() => {})
    }
    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 200))
  }, 5000)

  describe(`Snapshot Discovery`, () => {
    describe(`snapshot.discovery-new-doc`, () => {
      it(`should redirect to offset=-1 for new document`, async () => {
        const docId = `discovery-new-${Date.now()}`

        const response = await fetch(
          `${baseUrl}/docs/${docId}?offset=snapshot`,
          {
            method: `GET`,
            redirect: `manual`,
          }
        )

        expect(response.status).toBe(307)
        const location = response.headers.get(`location`)
        expect(location).toContain(`offset=-1`)
      })
    })

    describe(`snapshot.discovery-cached`, () => {
      it(`should include Cache-Control header`, async () => {
        const docId = `discovery-cached-${Date.now()}`

        const response = await fetch(
          `${baseUrl}/docs/${docId}?offset=snapshot`,
          {
            method: `GET`,
            redirect: `manual`,
          }
        )

        expect(response.status).toBe(307)
        const cacheControl = response.headers.get(`cache-control`)
        expect(cacheControl).toBe(`private, max-age=5`)
      })
    })
  })

  describe(`Document Operations`, () => {
    let providers: Array<YjsProvider> = []

    afterEach(() => {
      for (const provider of providers) {
        provider.destroy()
      }
      providers = []
    })

    async function createProviderWithDoc(
      docId: string,
      options?: {
        doc?: Y.Doc
        awareness?: Awareness
        connect?: boolean
        skipDocCreation?: boolean
      }
    ): Promise<YjsProvider> {
      const doc = options?.doc ?? new Y.Doc()

      // Create the document on the server first (unless skipped)
      if (!options?.skipDocCreation) {
        await createDocument(baseUrl, docId)
      }

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

    describe(`write.creates-document`, () => {
      it(`should create document on first write`, async () => {
        const docId = `create-on-write-${Date.now()}`
        const doc = new Y.Doc()
        const provider = await createProviderWithDoc(docId, { doc })

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
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text1 = doc1.getText(`content`)
        text1.insert(0, `Hello from doc1`)

        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after update`,
        })

        // Provider 2 joins and should receive the content (doc already exists)
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })
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

        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })

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

    describe(`doc.path-with-slashes`, () => {
      it(`should support document paths with forward slashes`, async () => {
        const docId = `project/chapter-1/section-a`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)
        text.insert(0, `Nested path works`)

        await waitForCondition(() => provider1.synced, {
          label: `provider synced after update`,
        })

        // Second provider should also sync
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })
        await waitForSync(provider2)

        expect(doc2.getText(`content`).toString()).toBe(`Nested path works`)
      })
    })

    describe(`Concurrent edits`, () => {
      it(`should handle concurrent edits with CRDT convergence`, async () => {
        const docId = `concurrent-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })

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
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const map1 = doc1.getMap(`settings`)

        // Set both properties in a single transaction
        doc1.transact(() => {
          map1.set(`theme`, `dark`)
          map1.set(`fontSize`, 14)
        })

        // Wait for the update to be synced
        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after map updates`,
        })

        // Give a bit of time for the write to propagate
        await new Promise((r) => setTimeout(r, 200))

        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })
        await waitForSync(provider2)

        const map2 = doc2.getMap(`settings`)
        expect(map2.get(`theme`)).toBe(`dark`)
        expect(map2.get(`fontSize`)).toBe(14)
      })

      it(`should sync Y.Array`, async () => {
        const docId = `array-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const array1 = doc1.getArray(`items`)
        array1.push([`item1`, `item2`, `item3`])

        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after array updates`,
        })

        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })
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

    async function createProviderWithDoc(
      docId: string,
      options?: {
        doc?: Y.Doc
        awareness?: Awareness
        skipDocCreation?: boolean
      }
    ): Promise<YjsProvider> {
      const doc = options?.doc ?? new Y.Doc()
      const awareness = options?.awareness ?? new Awareness(doc)

      // Create the document on the server first (unless skipped)
      if (!options?.skipDocCreation) {
        await createDocument(baseUrl, docId)
      }

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
        const provider1 = await createProviderWithDoc(docId, {
          doc: doc1,
          awareness: awareness1,
        })
        await waitForSync(provider1)

        const doc2 = new Y.Doc()
        const awareness2 = new Awareness(doc2)
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          awareness: awareness2,
          skipDocCreation: true,
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
      // TODO: This test is flaky due to SSE stream timing issues.
      // The awareness removal relies on the y-protocols/awareness timeout mechanism
      // which defaults to 30 seconds. The immediate removal notification via SSE
      // may not always be delivered in time during tests.
      it.skip(`should remove awareness state after disconnect`, async () => {
        const docId = `awareness-cleanup-${Date.now()}`

        const doc1 = new Y.Doc()
        const awareness1 = new Awareness(doc1)
        const provider1 = await createProviderWithDoc(docId, {
          doc: doc1,
          awareness: awareness1,
        })
        await waitForSync(provider1)

        const doc2 = new Y.Doc()
        const awareness2 = new Awareness(doc2)
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          awareness: awareness2,
          skipDocCreation: true,
        })
        await waitForSync(provider2)

        await ensureAwarenessDelivery(
          awareness1,
          awareness2,
          { key: `user`, value: { name: `Alice` } },
          (state) => Boolean((state as { user?: object } | undefined)?.user),
          `provider2 sees provider1 awareness`
        )

        // Store client ID before destroy
        const client1Id = awareness1.clientID

        // Remove from tracked providers first to prevent auto-cleanup
        const idx = providers.indexOf(provider1)
        if (idx > -1) providers.splice(idx, 1)

        provider1.destroy()

        // Awareness uses a 30-second timeout by default. The removal notification
        // should be sent immediately on disconnect, but we might need to wait
        // for it to propagate.
        await waitForAwarenessState(
          awareness2,
          client1Id,
          (state) => state === undefined,
          `provider2 observes provider1 removal`
        )
      }, 10000)
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

    async function createProviderWithDoc(
      docId: string,
      options?: {
        doc?: Y.Doc
        skipDocCreation?: boolean
      }
    ): Promise<YjsProvider> {
      const doc = options?.doc ?? new Y.Doc()

      // Create the document on the server first (unless skipped)
      if (!options?.skipDocCreation) {
        await createDocument(baseUrl, docId)
      }

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
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)

        // Write enough data to trigger compaction (threshold is ~1.5KB)
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        // Wait for snapshot to exist
        await waitForSnapshot(baseUrl, docId)

        // Second provider should be able to sync even if compaction happened
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })
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
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        await waitForSnapshot(baseUrl, docId)

        text.insert(text.length, `POST`)
        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after post-compaction update`,
        })

        const expected = text.toString()

        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })
        await waitForSync(provider2)

        await waitForDocText(doc2, `content`, expected)
      })
    })

    describe(`compaction.live-streaming`, () => {
      it(`should continue streaming during compaction`, async () => {
        const docId = `compaction-live-${Date.now()}`

        const doc1 = new Y.Doc()
        const doc2 = new Y.Doc()

        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
          skipDocCreation: true,
        })

        await waitForSync(provider1)
        await waitForSync(provider2)

        const text = doc1.getText(`content`)
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        await waitForSnapshot(baseUrl, docId)

        text.insert(text.length, `AFTER`)
        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after live update`,
        })

        await waitForDocText(doc2, `content`, text.toString())
        expect(provider2.connected).toBe(true)
      })
    })

    describe(`compaction.snapshot-discovery`, () => {
      it(`should redirect to snapshot after compaction`, async () => {
        const docId = `compaction-discovery-${Date.now()}`

        const doc = new Y.Doc()
        const provider = await createProviderWithDoc(docId, { doc })
        await waitForSync(provider)

        const text = doc.getText(`content`)
        await appendWithSync(provider, text, `X`.repeat(200), 10)

        // Wait for snapshot
        const snapshotKey = await waitForSnapshot(baseUrl, docId)
        expect(snapshotKey).toMatch(/_snapshot$/)

        // Verify the redirect
        const response = await fetch(
          `${baseUrl}/docs/${docId}?offset=snapshot`,
          {
            method: `GET`,
            redirect: `manual`,
          }
        )

        expect(response.status).toBe(307)
        const location = response.headers.get(`location`)
        expect(location).toContain(`_snapshot`)
      })
    })

    describe(`compaction.concurrent-writes`, () => {
      it(`should avoid concurrent compactions and keep updates`, async () => {
        const docId = `compaction-concurrent-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
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
          await waitForSnapshot(baseUrl, docId)

          expect(spy).toHaveBeenCalledTimes(1)

          const doc2 = new Y.Doc()
          const provider2 = await createProviderWithDoc(docId, {
            doc: doc2,
            skipDocCreation: true,
          })
          await waitForSync(provider2)

          await waitForDocText(doc2, `content`, text.toString())
        } finally {
          allowCompaction()
          spy.mockRestore()
        }
      })
    })
  })

  // Server restart test requires local servers - skip when using external URL
  // TODO: Debug why provider2 doesn't sync after serverB starts
  describe.skipIf(!!externalServerUrl)(`Server Restart`, () => {
    it.skip(
      `should preserve document state across restarts`,
      { timeout: 30000 },
      async () => {
        const docId = `restart-${Date.now()}`
        const service = `restart`

        const serverA = new YjsServer({
          port: 0,
          dsServerUrl: dsServer!.url,
          compactionThreshold: 1500,
          minUpdatesBeforeCompaction: 5,
        })
        await serverA.start()

        const baseUrlA = `${serverA.url}/v1/yjs/${service}`

        // Create the document first via PUT
        await createDocument(baseUrlA, docId)

        const doc = new Y.Doc()
        const provider = new YjsProvider({
          doc,
          baseUrl: baseUrlA,
          docId,
        })

        try {
          await waitForSync(provider)

          const text = doc.getText(`content`)
          await appendWithSync(provider, text, `R`.repeat(200), 10)

          await waitForSnapshot(baseUrlA, docId)
        } finally {
          provider.destroy()
          await serverA.stop()
        }

        const serverB = new YjsServer({
          port: 0,
          dsServerUrl: dsServer!.url,
          compactionThreshold: 1500,
          minUpdatesBeforeCompaction: 5,
        })
        await serverB.start()

        const baseUrlB = `${serverB.url}/v1/yjs/${service}`

        try {
          const doc2 = new Y.Doc()
          const provider2 = new YjsProvider({
            doc: doc2,
            baseUrl: baseUrlB,
            docId,
          })
          await waitForSync(provider2)

          // Should have synced the content
          expect(doc2.getText(`content`).toString().length).toBe(2000)

          provider2.destroy()
        } finally {
          await serverB.stop()
        }
      }
    )
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

  describe(`Path Validation`, () => {
    describe(`error.invalid-doc-path`, () => {
      // Note: Browser/fetch normalizes paths like foo/../bar before sending,
      // so server-side validation can only catch URL-encoded path traversal.
      it(`should reject URL-encoded paths with .. segments`, async () => {
        // Use %2F for / to prevent normalization, and encode the full path
        const response = await fetch(
          `${baseUrl}/docs/foo%2F..%2Fbar?offset=snapshot`,
          {
            method: `GET`,
            redirect: `manual`,
          }
        )

        expect(response.status).toBe(400)
      })

      it(`should reject URL-encoded paths with . segments`, async () => {
        const response = await fetch(
          `${baseUrl}/docs/foo%2F.%2Fbar?offset=snapshot`,
          {
            method: `GET`,
            redirect: `manual`,
          }
        )

        expect(response.status).toBe(400)
      })
    })
  })
})

/**
 * Yjs Durable Streams Protocol Conformance Tests
 *
 * These tests verify the Yjs protocol implementation by:
 * 1. Starting a durable streams server (underlying storage)
 * 2. Starting a Yjs server (protocol layer)
 * 3. Testing various scenarios with the YjsProvider
 *
 * Protocol: https://github.com/durable-streams/durable-streams/blob/main/packages/y-durable-streams/YJS-PROTOCOL.md
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
  condition: () => boolean | Promise<boolean>,
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
    if (await condition()) return
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

  if (
    response.status !== 201 &&
    response.status !== 200 &&
    response.status !== 409
  ) {
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
        await createDocument(baseUrl, docId)

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
        await createDocument(baseUrl, docId)

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

    describe(`snapshot.discovery-requires-put`, () => {
      it(`should return 404 for non-existent document`, async () => {
        const docId = `discovery-no-put-${Date.now()}`

        const response = await fetch(
          `${baseUrl}/docs/${docId}?offset=snapshot`,
          {
            method: `GET`,
            redirect: `manual`,
          }
        )

        expect(response.status).toBe(404)
        const body = await response.json()
        expect(body.error.code).toBe(`DOCUMENT_NOT_FOUND`)
      })
    })

    describe(`snapshot.not-found`, () => {
      it(`should return 404 with SNAPSHOT_NOT_FOUND for invalid snapshot offset`, async () => {
        const docId = `snapshot-notfound-${Date.now()}`
        await createDocument(baseUrl, docId)

        const response = await fetch(
          `${baseUrl}/docs/${docId}?offset=9999999999999999_9999999999999999_snapshot`,
          { method: `GET` }
        )

        expect(response.status).toBe(404)
        const body = await response.json()
        expect(body.error).toBeDefined()
        expect(body.error.code).toBe(`SNAPSHOT_NOT_FOUND`)
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
      }
    ): Promise<YjsProvider> {
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

    describe(`write.requires-put`, () => {
      it(`should sync document after PUT`, async () => {
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

      it(`should return 404 on POST without prior PUT`, async () => {
        const docId = `no-put-post-${Date.now()}`

        const response = await fetch(`${baseUrl}/docs/${docId}`, {
          method: `POST`,
          headers: { "content-type": `application/octet-stream` },
          body: new Uint8Array([1, 2, 3]),
        })

        expect(response.status).toBe(404)
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
        const docId = `project-${Date.now()}/chapter-1/section-a`

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

    describe(`write.rapid-batched-updates`, () => {
      it(`should handle rapid writes that trigger batching`, async () => {
        // This test validates that lib0 framing on the client works correctly
        // when the IdempotentProducer batches multiple append() calls into
        // a single HTTP request (concatenating the bytes).
        const docId = `rapid-writes-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)

        // Simulate rapid typing - insert many characters without awaiting
        // This will trigger batching in the IdempotentProducer
        const chars = `The quick brown fox jumps over the lazy dog. `.repeat(5)
        for (let i = 0; i < chars.length; i++) {
          text.insert(i, chars[i]!)
        }

        // Wait for producer to flush all batches
        await provider1.flush()

        // Give time for updates to be stored and echoed back
        await new Promise((r) => setTimeout(r, 500))

        // Verify local document has all content
        expect(text.toString()).toBe(chars)

        // Now verify a second client can read all the batched updates correctly
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
        })
        await waitForSync(provider2)

        // Second client should have identical content
        await waitForCondition(
          () => doc2.getText(`content`).toString() === chars,
          { label: `second client syncs all batched updates` }
        )

        expect(doc2.getText(`content`).toString()).toBe(chars)
      })

      it(`should handle multiple rapid bursts`, async () => {
        const docId = `rapid-bursts-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)

        // Burst 1: rapid inserts
        for (let i = 0; i < 50; i++) {
          text.insert(text.length, `A`)
        }

        // Small pause to let some batches complete
        await new Promise((r) => setTimeout(r, 20))

        // Burst 2: more rapid inserts
        for (let i = 0; i < 50; i++) {
          text.insert(text.length, `B`)
        }

        // Flush and wait
        await provider1.flush()
        await new Promise((r) => setTimeout(r, 300))

        const expected = `A`.repeat(50) + `B`.repeat(50)
        expect(text.toString()).toBe(expected)

        // Verify second client gets correct content
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
        })
        await waitForSync(provider2)

        await waitForCondition(
          () => doc2.getText(`content`).toString() === expected,
          { label: `second client syncs burst updates` }
        )

        expect(doc2.getText(`content`).toString()).toBe(expected)
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
      }
    ): Promise<YjsProvider> {
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

    describe(`presence.created-with-doc`, () => {
      it(`should sync awareness when document created via PUT`, async () => {
        const docId = `awareness-implicit-${Date.now()}`

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
        })
        await waitForSync(provider2)

        await ensureAwarenessDelivery(
          awareness1,
          awareness2,
          { key: `user`, value: { name: `Implicit` } },
          (state) =>
            (state as { user?: { name?: string } } | undefined)?.user?.name ===
            `Implicit`,
          `provider2 sees provider1 awareness without PUT`
        )
      })
    })

    describe(`presence.rapid-updates`, () => {
      it(`should deliver multiple rapid awareness updates correctly`, async () => {
        const docId = `awareness-rapid-${Date.now()}`

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
        })
        await waitForSync(provider2)

        // Send multiple rapid updates to exercise lib0 framing under batching
        for (let i = 0; i < 5; i++) {
          awareness1.setLocalStateField(`cursor`, { x: i * 10, y: i * 20 })
        }

        // The final state should arrive at provider2
        await waitForAwarenessState(
          awareness2,
          awareness1.clientID,
          (state) =>
            (state as { cursor?: { x?: number } } | undefined)?.cursor?.x ===
            40,
          `provider2 sees final rapid awareness update`
        )

        const finalState = awareness2.getStates().get(awareness1.clientID) as {
          cursor: { x: number; y: number }
        }
        expect(finalState.cursor).toEqual({ x: 40, y: 80 })
      })
    })

    describe(`presence.cleanup`, () => {
      it(`should remove awareness state after disconnect`, async () => {
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

  describe(`Awareness Stream Management`, () => {
    describe(`awareness.put-creates-stream`, () => {
      it(`should create awareness stream via PUT and POST to it`, async () => {
        const docId = `aw-put-create-${Date.now()}`
        await createDocument(baseUrl, docId)

        // PUT to create a custom awareness stream
        const putResponse = await fetch(
          `${baseUrl}/docs/${docId}?awareness=cursors`,
          { method: `PUT` }
        )
        expect(putResponse.status).toBe(201)
        await putResponse.arrayBuffer()

        // POST to the new awareness stream should succeed
        const postResponse = await fetch(
          `${baseUrl}/docs/${docId}?awareness=cursors`,
          {
            method: `POST`,
            headers: { "content-type": `application/octet-stream` },
            body: new Uint8Array([1, 2, 3]),
          }
        )
        expect(postResponse.status).not.toBe(404)
      })
    })

    describe(`awareness.put-idempotent`, () => {
      it(`should return 201 on first PUT and 200 on subsequent PUT`, async () => {
        const docId = `aw-put-idempotent-${Date.now()}`
        await createDocument(baseUrl, docId)

        const firstPut = await fetch(
          `${baseUrl}/docs/${docId}?awareness=presence`,
          { method: `PUT` }
        )
        expect(firstPut.status).toBe(201)
        await firstPut.arrayBuffer()

        const secondPut = await fetch(
          `${baseUrl}/docs/${docId}?awareness=presence`,
          { method: `PUT` }
        )
        expect(secondPut.status).toBe(200)
        await secondPut.arrayBuffer()
      })
    })

    describe(`awareness.put-requires-document`, () => {
      it(`should return 404 when PUTting awareness for non-existent document`, async () => {
        const docId = `aw-put-no-doc-${Date.now()}`

        const response = await fetch(
          `${baseUrl}/docs/${docId}?awareness=default`,
          { method: `PUT` }
        )
        expect(response.status).toBe(404)
        const body = await response.json()
        expect(body.error.code).toBe(`DOCUMENT_NOT_FOUND`)
      })
    })

    describe(`awareness.put-records-index`, () => {
      it(`should record non-default awareness stream in awareness index`, async () => {
        const docId = `aw-put-index-${Date.now()}`
        await createDocument(baseUrl, docId)

        // Create a custom awareness stream
        const putResponse = await fetch(
          `${baseUrl}/docs/${docId}?awareness=admin`,
          { method: `PUT` }
        )
        expect(putResponse.status).toBe(201)
        await putResponse.arrayBuffer()

        // Read the awareness index stream from the DS server
        // The DS server returns JSON arrays for application/json streams
        const indexPath = `/v1/stream/yjs/test/docs/${docId}/.awareness/.index`
        const indexResponse = await fetch(
          `${dsServer!.url}${indexPath}?offset=-1`
        )
        expect(indexResponse.status).toBe(200)
        const indexBody = await indexResponse.text()
        const parsed = JSON.parse(indexBody.trim())
        const entries = Array.isArray(parsed) ? parsed : [parsed]
        expect(entries).toHaveLength(1)
        expect(entries[0].name).toBe(`admin`)
        expect(entries[0].createdAt).toBeTypeOf(`number`)
      })

      it(`should not duplicate index entry on repeated PUT`, async () => {
        const docId = `aw-put-no-dup-${Date.now()}`
        await createDocument(baseUrl, docId)

        // Create twice
        const put1 = await fetch(`${baseUrl}/docs/${docId}?awareness=editors`, {
          method: `PUT`,
        })
        expect(put1.status).toBe(201)
        await put1.arrayBuffer()

        const put2 = await fetch(`${baseUrl}/docs/${docId}?awareness=editors`, {
          method: `PUT`,
        })
        expect(put2.status).toBe(200)
        await put2.arrayBuffer()

        // Read the awareness index — should have exactly one entry
        const indexPath = `/v1/stream/yjs/test/docs/${docId}/.awareness/.index`
        const indexResponse = await fetch(
          `${dsServer!.url}${indexPath}?offset=-1`
        )
        expect(indexResponse.status).toBe(200)
        const indexBody = await indexResponse.text()
        const parsed = JSON.parse(indexBody.trim())
        const entries = Array.isArray(parsed) ? parsed : [parsed]
        expect(entries).toHaveLength(1)
      })

      it(`should not record default awareness stream in index`, async () => {
        const docId = `aw-put-no-default-index-${Date.now()}`
        await createDocument(baseUrl, docId)

        // PUT default awareness stream (already created with doc, returns 200)
        const putResponse = await fetch(
          `${baseUrl}/docs/${docId}?awareness=default`,
          { method: `PUT` }
        )
        expect(putResponse.status).toBe(200)
        await putResponse.arrayBuffer()

        // The awareness index stream should not exist (no non-default streams created)
        const indexPath = `/v1/stream/yjs/test/docs/${docId}/.awareness/.index`
        const indexResponse = await fetch(
          `${dsServer!.url}${indexPath}?offset=-1`
        )
        expect(indexResponse.status).toBe(404)
      })
    })

    describe(`awareness.named-streams-separate`, () => {
      it(`should keep named awareness streams separate`, async () => {
        const docId = `aw-multi-${Date.now()}`
        await createDocument(baseUrl, docId)

        // Create two custom awareness streams
        const put1 = await fetch(`${baseUrl}/docs/${docId}?awareness=cursors`, {
          method: `PUT`,
        })
        expect(put1.status).toBe(201)
        await put1.arrayBuffer()

        const put2 = await fetch(
          `${baseUrl}/docs/${docId}?awareness=presence`,
          { method: `PUT` }
        )
        expect(put2.status).toBe(201)
        await put2.arrayBuffer()

        // POST to cursors
        const postCursors = await fetch(
          `${baseUrl}/docs/${docId}?awareness=cursors`,
          {
            method: `POST`,
            headers: { "content-type": `application/octet-stream` },
            body: new Uint8Array([10, 20, 30]),
          }
        )
        expect(postCursors.status).not.toBe(404)

        // POST to presence
        const postPresence = await fetch(
          `${baseUrl}/docs/${docId}?awareness=presence`,
          {
            method: `POST`,
            headers: { "content-type": `application/octet-stream` },
            body: new Uint8Array([40, 50, 60]),
          }
        )
        expect(postPresence.status).not.toBe(404)

        // Read cursors stream — should only have its data
        const cursorsPath = `/v1/stream/yjs/test/docs/${docId}/.awareness/cursors`
        const cursorsResponse = await fetch(
          `${dsServer!.url}${cursorsPath}?offset=-1`
        )
        expect(cursorsResponse.status).toBe(200)
        const cursorsData = new Uint8Array(await cursorsResponse.arrayBuffer())

        // Read presence stream — should only have its data
        const presencePath = `/v1/stream/yjs/test/docs/${docId}/.awareness/presence`
        const presenceResponse = await fetch(
          `${dsServer!.url}${presencePath}?offset=-1`
        )
        expect(presenceResponse.status).toBe(200)
        const presenceData = new Uint8Array(
          await presenceResponse.arrayBuffer()
        )

        // Verify they contain different data
        expect(cursorsData).not.toEqual(presenceData)
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

    async function createProviderWithDoc(
      docId: string,
      options?: {
        doc?: Y.Doc
      }
    ): Promise<YjsProvider> {
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
          })
          await waitForSync(provider2)

          await waitForDocText(doc2, `content`, text.toString())
        } finally {
          allowCompaction()
          spy.mockRestore()
        }
      })
    })

    describe(`compaction.stream-next-offset`, () => {
      it(`should return correct stream-next-offset header on snapshot read`, async () => {
        const docId = `snapshot-offset-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        const snapshotKey = await waitForSnapshot(baseUrl, docId)

        // Read the snapshot directly and check the header
        const response = await fetch(
          `${baseUrl}/docs/${docId}?offset=${encodeURIComponent(snapshotKey)}`,
          { method: `GET` }
        )

        expect(response.status).toBe(200)
        const nextOffset = response.headers.get(`stream-next-offset`)
        expect(nextOffset).toBeTruthy()

        // The next offset should be one past the snapshot offset (without _snapshot suffix)
        // e.g. snapshot at 0000000000000000_0000000000001555 → next offset 0000000000000000_0000000000001556
        const snapshotOffset = snapshotKey.replace(/_snapshot$/, ``)
        const parts = snapshotOffset.split(`_`)
        const expectedSeq = (parseInt(parts[1]!, 10) + 1)
          .toString()
          .padStart(parts[1]!.length, `0`)
        const expectedOffset = `${parts[0]}_${expectedSeq}`
        expect(nextOffset).toBe(expectedOffset)

        // Verify we can read updates from that offset without error
        const updatesResponse = await fetch(
          `${baseUrl}/docs/${docId}?offset=${encodeURIComponent(nextOffset!)}`,
          { method: `GET` }
        )
        // Should succeed (200 with data or 204 if caught up)
        expect([200, 204]).toContain(updatesResponse.status)
      })
    })

    describe(`compaction.stale-client-resume`, () => {
      it(`should sync correctly when client resumes from pre-snapshot offset`, async () => {
        const docId = `stale-resume-${Date.now()}`

        // Provider 1 writes data and triggers compaction
        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text1 = doc1.getText(`content`)

        // Write some initial data
        text1.insert(0, `BEFORE`)
        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after initial write`,
        })

        // Provider 2 joins and syncs (gets an offset before compaction)
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
        })
        await waitForSync(provider2)
        expect(doc2.getText(`content`).toString()).toBe(`BEFORE`)

        // Disconnect provider 2 (simulating going offline)
        provider2.disconnect()

        // Write enough data to trigger compaction while provider2 is offline
        await appendWithSync(provider1, text1, `X`.repeat(200), 10)
        await waitForSnapshot(baseUrl, docId)

        // Write more data after compaction
        text1.insert(text1.length, `AFTER`)
        await waitForCondition(() => provider1.synced, {
          label: `provider1 synced after post-compaction write`,
        })

        const expected = text1.toString()

        // Reconnect provider 2 - it will resume and should get all data
        await provider2.connect()
        await waitForSync(provider2)

        await waitForDocText(doc2, `content`, expected)
      })
    })

    describe(`compaction.snapshot-404-retry`, () => {
      it(`should handle deleted snapshot by retrying discovery`, async () => {
        const docId = `snapshot-404-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)
        await appendWithSync(provider1, text, `X`.repeat(200), 10)

        const firstSnapshotKey = await waitForSnapshot(baseUrl, docId)

        // Verify the snapshot exists
        const checkResponse = await fetch(
          `${baseUrl}/docs/${docId}?offset=${encodeURIComponent(firstSnapshotKey)}`,
          { method: `GET` }
        )
        expect(checkResponse.status).toBe(200)
        // consume the body
        await checkResponse.arrayBuffer()

        // Trigger another compaction so the first snapshot gets deleted
        await appendWithSync(provider1, text, `Y`.repeat(200), 10)
        const secondSnapshotKey = await waitForSnapshot(baseUrl, docId)

        // Wait for old snapshot to be deleted (async cleanup)
        await waitForCondition(
          async () => {
            const r = await fetch(
              `${baseUrl}/docs/${docId}?offset=${encodeURIComponent(firstSnapshotKey)}`,
              { method: `GET` }
            )
            await r.arrayBuffer()
            return r.status === 404
          },
          { label: `old snapshot deleted`, timeoutMs: 5000 }
        )

        // A new client using the old (deleted) snapshot offset should handle the 404
        // and fall back to the current snapshot
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
        })
        await waitForSync(provider2)

        expect(doc2.getText(`content`).toString()).toBe(text.toString())
        expect(secondSnapshotKey).not.toBe(firstSnapshotKey)
      })
    })

    describe(`compaction.multiple-cycles`, () => {
      it(`should discover latest snapshot after multiple compactions`, async () => {
        const docId = `multi-compact-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)

        // First compaction
        await appendWithSync(provider1, text, `A`.repeat(200), 10)
        const snapshot1 = await waitForSnapshot(baseUrl, docId)

        // Second compaction
        await appendWithSync(provider1, text, `B`.repeat(200), 10)

        // Wait for a new snapshot (different from snapshot1)
        await waitForCondition(
          async () => {
            const r = await fetch(`${baseUrl}/docs/${docId}?offset=snapshot`, {
              method: `GET`,
              redirect: `manual`,
            })
            if (r.status === 307) {
              const loc = r.headers.get(`location`)
              if (loc) {
                const match = loc.match(/offset=([^&]+_snapshot)/)
                return match != null && match[1] !== snapshot1
              }
            }
            return false
          },
          { label: `second snapshot different from first` }
        )

        // Third compaction
        await appendWithSync(provider1, text, `C`.repeat(200), 10)

        // Wait for yet another snapshot
        const snapshot3 = await waitForSnapshot(baseUrl, docId)

        // Snapshot should be different from the first
        expect(snapshot3).not.toBe(snapshot1)

        // A new client should sync the full document state
        const doc2 = new Y.Doc()
        const provider2 = await createProviderWithDoc(docId, {
          doc: doc2,
        })
        await waitForSync(provider2)

        expect(doc2.getText(`content`).toString()).toBe(text.toString())
        // 10 * 200 * 3 = 6000 chars of A/B/C
        expect(doc2.getText(`content`).toString().length).toBe(6000)
      })
    })

    describe(`compaction.read-from-pre-snapshot-offset`, () => {
      it(`should return updates when reading from offset before snapshot`, async () => {
        const docId = `pre-snapshot-read-${Date.now()}`

        const doc1 = new Y.Doc()
        const provider1 = await createProviderWithDoc(docId, { doc: doc1 })
        await waitForSync(provider1)

        const text = doc1.getText(`content`)

        // Write initial data and capture the offset
        text.insert(0, `INITIAL`)
        await provider1.flush()
        await waitForCondition(() => provider1.synced, {
          label: `synced after initial write`,
        })

        // Read from beginning to get the current offset
        const initialResponse = await fetch(
          `${baseUrl}/docs/${docId}?offset=-1`,
          { method: `GET` }
        )
        expect(initialResponse.status).toBe(200)
        const earlyOffset =
          initialResponse.headers.get(`stream-next-offset`) ??
          initialResponse.headers.get(`stream-cursor`)
        await initialResponse.arrayBuffer()

        // Now write enough to trigger compaction
        await appendWithSync(provider1, text, `X`.repeat(200), 10)
        await waitForSnapshot(baseUrl, docId)

        // Read updates from the early offset (before the snapshot)
        // The underlying DS stream should still have all data
        const updatesResponse = await fetch(
          `${baseUrl}/docs/${docId}?offset=${encodeURIComponent(earlyOffset ?? `-1`)}`,
          { method: `GET` }
        )

        // Should succeed - updates are never deleted by compaction
        expect(updatesResponse.status).toBe(200)
        const body = await updatesResponse.arrayBuffer()
        expect(body.byteLength).toBeGreaterThan(0)
      })
    })
  })

  // Server restart test requires local servers - skip when using external URL
  describe.skipIf(!!externalServerUrl)(`Server Restart`, () => {
    it(
      `should preserve document state across restarts`,
      { timeout: 30000 },
      async () => {
        const docId = `restart-${Date.now()}`
        const service = `restart`

        const serverA = new YjsServer({
          port: 0,
          dsServerUrl: dsServer!.url,
          compactionThreshold: 1500,
        })
        await serverA.start()

        const baseUrlA = `${serverA.url}/v1/yjs/${service}`

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

  describe(`Method Validation`, () => {
    // Document URLs accept: GET, HEAD, POST, PUT
    const unsupportedDocMethods = [`DELETE`, `PATCH`]
    for (const method of unsupportedDocMethods) {
      it(`should reject ${method} on document URL with 405`, async () => {
        const docId = `method-doc-${method.toLowerCase()}-${Date.now()}`
        const response = await fetch(`${baseUrl}/docs/${docId}`, { method })
        expect(response.status).toBe(405)
        const body = await response.json()
        expect(body.error.code).toBe(`INVALID_REQUEST`)
      })
    }

    // Awareness URLs accept: GET, HEAD, POST, PUT
    const unsupportedAwarenessMethods = [`DELETE`, `PATCH`]
    for (const method of unsupportedAwarenessMethods) {
      it(`should reject ${method} on awareness URL with 405`, async () => {
        const docId = `method-aw-${method.toLowerCase()}-${Date.now()}`
        const response = await fetch(
          `${baseUrl}/docs/${docId}?awareness=default`,
          { method }
        )
        expect(response.status).toBe(405)
        const body = await response.json()
        expect(body.error.code).toBe(`INVALID_REQUEST`)
      })
    }
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

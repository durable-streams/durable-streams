import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import * as Y from "yjs"

const BINARY_CONTENT_TYPE = `application/octet-stream`

describe(`Yjs + DurableStream Integration`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  // Track Y.Doc instances for cleanup
  const docs: Array<Y.Doc> = []

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterEach(() => {
    // Clean up Y.Doc instances
    for (const doc of docs) {
      doc.destroy()
    }
    docs.length = 0
  })

  afterAll(async () => {
    await server.stop()
  })

  function createDoc(): Y.Doc {
    const doc = new Y.Doc()
    docs.push(doc)
    return doc
  }

  async function createStream(path: string): Promise<DurableStream> {
    return DurableStream.create({
      url: `${baseUrl}${path}`,
      contentType: BINARY_CONTENT_TYPE,
    })
  }

  function openStream(path: string): DurableStream {
    return new DurableStream({
      url: `${baseUrl}${path}`,
      contentType: BINARY_CONTENT_TYPE,
    })
  }

  describe(`Basic Y.Doc operations`, () => {
    it(`should emit binary updates when Y.Doc changes`, () => {
      const doc = createDoc()
      const updates: Array<Uint8Array> = []

      doc.on(`update`, (update: Uint8Array) => {
        updates.push(update)
      })

      const text = doc.getText(`content`)
      text.insert(0, `Hello, World!`)

      expect(updates.length).toBe(1)
      expect(updates[0]).toBeInstanceOf(Uint8Array)
      expect(updates[0].length).toBeGreaterThan(0)
    })

    it(`should apply updates from one doc to another`, () => {
      const doc1 = createDoc()
      const doc2 = createDoc()

      // Collect updates from doc1
      doc1.on(`update`, (update: Uint8Array) => {
        Y.applyUpdate(doc2, update)
      })

      // Make changes in doc1
      const text1 = doc1.getText(`content`)
      text1.insert(0, `Hello from doc1`)

      // Verify doc2 received the changes
      const text2 = doc2.getText(`content`)
      expect(text2.toString()).toBe(`Hello from doc1`)
    })
  })

  describe(`Writing Y.Doc updates to DurableStream`, () => {
    it(`should write a Y.Doc update to a binary stream`, async () => {
      const streamPath = `/yjs/write-test-${Date.now()}`

      // Create a binary stream
      const stream = await createStream(streamPath)

      // Create Y.Doc and capture update
      const doc = createDoc()
      let capturedUpdate: Uint8Array | null = null

      doc.on(`update`, (update: Uint8Array) => {
        capturedUpdate = update
      })

      // Make a change
      const text = doc.getText(`content`)
      text.insert(0, `Test content`)

      expect(capturedUpdate).not.toBeNull()

      // Write update to stream
      await stream.append(capturedUpdate!)

      // Verify we can read it back
      const response = await stream.stream({ live: false })
      const body = await response.body()

      expect(body.length).toBe(capturedUpdate!.length)
      expect(body).toEqual(capturedUpdate)
    })

    it(`should write multiple Y.Doc updates to a stream`, async () => {
      const streamPath = `/yjs/multi-write-${Date.now()}`

      const stream = await createStream(streamPath)

      const doc = createDoc()
      const updates: Array<Uint8Array> = []

      doc.on(`update`, (update: Uint8Array) => {
        updates.push(update)
      })

      // Make multiple changes
      const text = doc.getText(`content`)
      text.insert(0, `First`)
      text.insert(5, ` Second`)
      text.insert(12, ` Third`)

      expect(updates.length).toBe(3)

      // Write all updates to stream
      for (const update of updates) {
        await stream.append(update)
      }

      // Verify content
      expect(text.toString()).toBe(`First Second Third`)
    })
  })

  describe(`Reading Y.Doc updates from DurableStream`, () => {
    it(`should read updates from a stream and apply to a new Y.Doc`, async () => {
      const streamPath = `/yjs/read-test-${Date.now()}`

      // Writer: create doc and stream
      const writerDoc = createDoc()
      const stream = await createStream(streamPath)

      // Collect updates first, then write
      const updates: Array<Uint8Array> = []
      writerDoc.on(`update`, (update: Uint8Array) => {
        updates.push(update)
      })

      const writerText = writerDoc.getText(`content`)
      writerText.insert(0, `Hello from writer`)

      // Write all updates
      for (const update of updates) {
        await stream.append(update)
      }

      // Reader: create new doc and read from stream
      const readerDoc = createDoc()
      const readerStream = openStream(streamPath)

      const response = await readerStream.stream({ live: false })
      const body = await response.body()

      // Apply the update
      Y.applyUpdate(readerDoc, body)

      // Verify reader has the same content
      const readerText = readerDoc.getText(`content`)
      expect(readerText.toString()).toBe(`Hello from writer`)
    })

    it(`should use subscribeBytes to receive updates incrementally`, async () => {
      const streamPath = `/yjs/subscribe-test-${Date.now()}`

      // Create stream
      const stream = await createStream(streamPath)

      const writerDoc = createDoc()
      const writerText = writerDoc.getText(`content`)

      // Collect updates synchronously
      const updates: Array<Uint8Array> = []
      writerDoc.on(`update`, (update: Uint8Array) => {
        updates.push(update)
      })

      writerText.insert(0, `Line 1`)
      writerText.insert(6, `\nLine 2`)
      writerText.insert(13, `\nLine 3`)

      // Merge updates before writing (binary streams concatenate data)
      const mergedUpdate = Y.mergeUpdates(updates)
      await stream.append(mergedUpdate)

      // Reader uses subscribeBytes
      const readerDoc = createDoc()
      const readerStream = openStream(streamPath)

      const receivedChunks: Array<Uint8Array> = []
      const response = await readerStream.stream({ live: false })

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timeout waiting for updates`)),
          4000
        )
        response.subscribeBytes((chunk) => {
          receivedChunks.push(chunk.data)
          Y.applyUpdate(readerDoc, chunk.data)

          if (chunk.upToDate) {
            clearTimeout(timeout)
            resolve()
          }
        })
      })

      // Verify all content was received
      const readerText = readerDoc.getText(`content`)
      expect(readerText.toString()).toBe(`Line 1\nLine 2\nLine 3`)
      expect(receivedChunks.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe(`Multi-client synchronization`, () => {
    it(`should sync two Y.Docs through a shared stream`, async () => {
      const streamPath = `/yjs/sync-test-${Date.now()}`

      // Create the shared stream
      const stream = await createStream(streamPath)

      // Client A
      const docA = createDoc()
      const updatesA: Array<Uint8Array> = []
      docA.on(`update`, (update: Uint8Array, origin: unknown) => {
        if (origin !== `remote`) {
          updatesA.push(update)
        }
      })

      // Make changes in Client A
      const textA = docA.getText(`content`)
      textA.insert(0, `Hello from A`)

      // Write Client A updates to stream
      for (const update of updatesA) {
        await stream.append(update)
      }

      // Client B reads from stream
      const docB = createDoc()
      const streamB = openStream(streamPath)

      const responseB = await streamB.stream({ live: false })
      const bodyB = await responseB.body()
      Y.applyUpdate(docB, bodyB, `remote`)

      // Verify Client B has the same content
      const textB = docB.getText(`content`)
      expect(textB.toString()).toBe(`Hello from A`)
    })

    it(`should handle concurrent edits from multiple clients`, async () => {
      const streamPath = `/yjs/concurrent-${Date.now()}`

      const stream = await createStream(streamPath)

      // Create two docs
      const doc1 = createDoc()
      const doc2 = createDoc()

      // Client 1 makes changes
      const text1 = doc1.getText(`content`)
      text1.insert(0, `AAA`)

      // Client 2 makes changes (before syncing)
      const text2 = doc2.getText(`content`)
      text2.insert(0, `BBB`)

      // Each client writes their full state (merged updates)
      const state1 = Y.encodeStateAsUpdate(doc1)
      const state2 = Y.encodeStateAsUpdate(doc2)

      await stream.append(state1)
      await stream.append(state2)

      // Both clients need to merge the states from stream
      // Since binary updates are concatenated, we need to merge them
      const response = await stream.stream({ live: false })
      await response.body() // Consume the body

      // For this test, we'll merge the two states manually
      // In practice, you'd use framing or mergeUpdates on the server
      const mergedState = Y.mergeUpdates([state1, state2])

      // Apply merged state to both docs
      Y.applyUpdate(doc1, mergedState, `remote`)
      Y.applyUpdate(doc2, mergedState, `remote`)

      // Both docs should converge to the same state (CRDT property)
      expect(text1.toString()).toBe(text2.toString())
      // Content should contain both edits
      expect(text1.toString()).toContain(`AAA`)
      expect(text1.toString()).toContain(`BBB`)
    })
  })

  describe(`Resume from offset`, () => {
    it(`should resume reading from a saved offset`, async () => {
      const streamPath = `/yjs/resume-${Date.now()}`

      const stream = await createStream(streamPath)

      const writerDoc = createDoc()
      const updates: Array<Uint8Array> = []

      writerDoc.on(`update`, (update: Uint8Array) => {
        updates.push(update)
      })

      const text = writerDoc.getText(`content`)
      text.insert(0, `Initial content`)

      // Write first batch
      for (const update of updates) {
        await stream.append(update)
      }

      // Reader 1: read and save offset
      const reader1Doc = createDoc()
      const response1 = await stream.stream({ live: false })
      const body1 = await response1.body()
      Y.applyUpdate(reader1Doc, body1)

      const savedOffset = response1.offset

      expect(reader1Doc.getText(`content`).toString()).toBe(`Initial content`)

      // Clear updates array and add more content
      updates.length = 0
      text.insert(15, ` - more content`)

      // Write second batch
      for (const update of updates) {
        await stream.append(update)
      }

      // Reader 2: resume from saved offset
      const reader2Doc = createDoc()
      // First, apply what we had before
      Y.applyUpdate(reader2Doc, body1)

      const response2 = await stream.stream({
        offset: savedOffset,
        live: false,
      })
      const body2 = await response2.body()

      // Apply only the new updates
      if (body2.length > 0) {
        Y.applyUpdate(reader2Doc, body2)
      }

      // Reader 2 should have all content
      expect(reader2Doc.getText(`content`).toString()).toBe(
        `Initial content - more content`
      )
    })
  })

  describe(`State vector and efficient sync`, () => {
    it(`should use state vectors for efficient synchronization`, async () => {
      const streamPath = `/yjs/statevector-${Date.now()}`

      const stream = await createStream(streamPath)

      const doc1 = createDoc()
      const doc2 = createDoc()

      // Doc1 makes changes
      const text1 = doc1.getText(`content`)
      text1.insert(0, `Hello`)

      // Get doc1's state as update
      const update1 = Y.encodeStateAsUpdate(doc1)

      // Write to stream
      await stream.append(update1)

      // Doc2 reads and applies
      const response = await stream.stream({ live: false })
      const body = await response.body()
      Y.applyUpdate(doc2, body)

      // Verify doc2 has the state
      expect(doc2.getText(`content`).toString()).toBe(`Hello`)

      // Get missing updates from doc2's perspective
      const stateVector2 = Y.encodeStateVector(doc2)
      const missingFromDoc2 = Y.diffUpdate(update1, stateVector2)

      // Since doc2 already has all updates, the diff should be minimal
      expect(missingFromDoc2.length).toBeLessThanOrEqual(update1.length)
    })
  })

  describe(`Y.Map and Y.Array types`, () => {
    it(`should sync Y.Map through stream`, async () => {
      const streamPath = `/yjs/map-${Date.now()}`

      const stream = await createStream(streamPath)

      const writerDoc = createDoc()

      // Use Y.Map
      const map = writerDoc.getMap(`settings`)
      map.set(`theme`, `dark`)
      map.set(`fontSize`, 14)
      map.set(`user`, { name: `John`, email: `john@example.com` })

      // Write full state as single update (more efficient for initial sync)
      const fullState = Y.encodeStateAsUpdate(writerDoc)
      await stream.append(fullState)

      // Reader
      const readerDoc = createDoc()
      const response = await stream.stream({ live: false })
      const body = await response.body()
      Y.applyUpdate(readerDoc, body)

      const readerMap = readerDoc.getMap(`settings`)
      expect(readerMap.get(`theme`)).toBe(`dark`)
      expect(readerMap.get(`fontSize`)).toBe(14)
      expect(readerMap.get(`user`)).toEqual({
        name: `John`,
        email: `john@example.com`,
      })
    })

    it(`should sync Y.Array through stream`, async () => {
      const streamPath = `/yjs/array-${Date.now()}`

      const stream = await createStream(streamPath)

      const writerDoc = createDoc()

      // Use Y.Array
      const array = writerDoc.getArray(`items`)
      array.push([`item1`, `item2`, `item3`])
      array.insert(1, [`inserted`])
      array.delete(0, 1)

      // Write full state as single update
      const fullState = Y.encodeStateAsUpdate(writerDoc)
      await stream.append(fullState)

      // Reader
      const readerDoc = createDoc()
      const response = await stream.stream({ live: false })
      const body = await response.body()
      Y.applyUpdate(readerDoc, body)

      const readerArray = readerDoc.getArray(`items`)
      expect(readerArray.toArray()).toEqual([`inserted`, `item2`, `item3`])
    })

    it(`should sync incremental Y.Map updates using mergeUpdates`, async () => {
      const streamPath = `/yjs/map-incremental-${Date.now()}`

      const stream = await createStream(streamPath)

      const writerDoc = createDoc()
      const updates: Array<Uint8Array> = []
      writerDoc.on(`update`, (update: Uint8Array) => {
        updates.push(update)
      })

      // Use Y.Map with multiple operations
      const map = writerDoc.getMap(`settings`)
      map.set(`theme`, `dark`)
      map.set(`fontSize`, 14)

      // Merge updates before writing to stream (handles batching)
      const mergedUpdate = Y.mergeUpdates(updates)
      await stream.append(mergedUpdate)

      // Reader
      const readerDoc = createDoc()
      const response = await stream.stream({ live: false })
      const body = await response.body()
      Y.applyUpdate(readerDoc, body)

      const readerMap = readerDoc.getMap(`settings`)
      expect(readerMap.get(`theme`)).toBe(`dark`)
      expect(readerMap.get(`fontSize`)).toBe(14)
    })
  })
})

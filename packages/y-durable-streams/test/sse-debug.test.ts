import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import * as Y from "yjs"
import { DurableStreamsProvider } from "../src"

describe(`SSE with base64 debug`, () => {
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

  it(`should read binary data via SSE with base64 encoding`, async () => {
    // Create a binary stream
    const stream = await DurableStream.create({
      url: `${baseUrl}/test-sse-base64-${Date.now()}`,
      contentType: `application/octet-stream`,
    })

    // Append some data
    const testData = new Uint8Array([1, 2, 3, 4, 5])
    await stream.append(testData)

    // Try to read with SSE and base64
    const response = await stream.stream({
      offset: `-1`,
      live: `sse`,
      encoding: `base64`,
    })

    const data = await response.body()

    expect(data).toEqual(testData)
  }, 10000)

  it(`should receive upToDate for empty stream via SSE`, async () => {
    // Create a binary stream with no data
    const stream = await DurableStream.create({
      url: `${baseUrl}/test-sse-empty-${Date.now()}`,
      contentType: `application/octet-stream`,
    })

    // Try to read with SSE and base64 using subscribeBytes (no data appended)
    const response = await stream.stream({
      offset: `-1`,
      live: `sse`,
      encoding: `base64`,
    })

    let upToDateReceived = false
    let dataLength = 0

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timeout - upToDate not received`)),
        5000
      )

      response.subscribeBytes((chunk) => {
        dataLength += chunk.data.length
        if (chunk.upToDate) {
          upToDateReceived = true
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    expect(upToDateReceived).toBe(true)
    expect(dataLength).toBe(0) // No data was appended
  }, 10000)

  it(`should receive lib0 framed data via SSE with base64`, async () => {
    // This test mimics how y-durable-streams uses lib0 VarUint8Array framing
    const { createEncoder, writeVarUint8Array, toUint8Array } = await import(
      `lib0/encoding`
    )
    const { createDecoder, readVarUint8Array, hasContent } = await import(
      `lib0/decoding`
    )

    // Create a binary stream
    const stream = await DurableStream.create({
      url: `${baseUrl}/test-sse-lib0-${Date.now()}`,
      contentType: `application/octet-stream`,
    })

    // Create lib0 framed data (like y-durable-streams does)
    const originalData = new Uint8Array([1, 2, 3, 4, 5])
    const encoder = createEncoder()
    writeVarUint8Array(encoder, originalData)
    const framedData = toUint8Array(encoder)

    // Append framed data
    await stream.append(framedData)

    // Read with SSE and base64
    const response = await stream.stream({
      offset: `-1`,
      live: `sse`,
      encoding: `base64`,
    })

    const receivedChunks: Array<Uint8Array> = []
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout`)), 5000)

      response.subscribeBytes((chunk) => {
        receivedChunks.push(chunk.data)
        if (chunk.upToDate) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    // Combine all chunks
    const totalLength = receivedChunks.reduce(
      (acc, chunk) => acc + chunk.length,
      0
    )
    const receivedData = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of receivedChunks) {
      receivedData.set(chunk, offset)
      offset += chunk.length
    }

    // Decode lib0 framed data
    const decoder = createDecoder(receivedData)
    expect(hasContent(decoder)).toBe(true)
    const decodedData = readVarUint8Array(decoder)

    expect(decodedData).toEqual(originalData)
  }, 10000)

  it(`should receive data via subscribeBytes with SSE`, async () => {
    // Create a binary stream
    const stream = await DurableStream.create({
      url: `${baseUrl}/test-sse-subscribe-${Date.now()}`,
      contentType: `application/octet-stream`,
    })

    // Append some data
    const testData = new Uint8Array([1, 2, 3, 4, 5])
    await stream.append(testData)

    // Try to read with SSE and base64 using subscribeBytes
    const response = await stream.stream({
      offset: `-1`,
      live: `sse`,
      encoding: `base64`,
    })

    const receivedChunks: Array<Uint8Array> = []
    let upToDateReceived = false

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout`)), 5000)

      response.subscribeBytes((chunk) => {
        receivedChunks.push(chunk.data)
        if (chunk.upToDate) {
          upToDateReceived = true
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    expect(upToDateReceived).toBe(true)
    expect(receivedChunks.length).toBeGreaterThanOrEqual(1)

    // Combine all chunks
    const totalLength = receivedChunks.reduce(
      (acc, chunk) => acc + chunk.length,
      0
    )
    const combinedData = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of receivedChunks) {
      combinedData.set(chunk, offset)
      offset += chunk.length
    }

    expect(combinedData).toEqual(testData)
  }, 10000)

  describe(`Provider-level SSE tests`, () => {
    const providers: Array<DurableStreamsProvider> = []

    afterEach(() => {
      for (const provider of providers) {
        provider.destroy()
      }
      providers.length = 0
    })

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

    it(`should sync provider with SSE transport`, async () => {
      const { createEncoder, writeVarUint8Array, toUint8Array } = await import(
        `lib0/encoding`
      )
      const { createDecoder, readVarUint8Array, hasContent } = await import(
        `lib0/decoding`
      )

      const roomId = `provider-sse-${Date.now()}`

      // First, test what Yjs produces for an update
      const testDoc = new Y.Doc()
      const updates: Array<Uint8Array> = []
      testDoc.on(`update`, (update: Uint8Array) => {
        updates.push(update)
      })
      testDoc.getText(`content`).insert(0, `Hello SSE`)

      console.log(`Yjs update: ${updates[0]!.length} bytes`, updates[0])

      // Now frame it with lib0
      const encoder = createEncoder()
      writeVarUint8Array(encoder, updates[0]!)
      const framedUpdate = toUint8Array(encoder)
      console.log(`Lib0 framed: ${framedUpdate.length} bytes`, framedUpdate)

      // Verify we can decode it
      const decoder = createDecoder(framedUpdate)
      console.log(`hasContent before decode: ${hasContent(decoder)}`)
      const decoded = readVarUint8Array(decoder)
      console.log(`Decoded update: ${decoded.length} bytes`)
      console.log(`hasContent after decode: ${hasContent(decoder)}`)

      // Now test with provider
      const stream = await DurableStream.create({
        url: `${baseUrl}/v1/stream/rooms/${roomId}`,
        contentType: `application/octet-stream`,
      })

      const doc1 = new Y.Doc()

      // Capture updates to see what's being generated
      const sentUpdates: Array<Uint8Array> = []
      doc1.on(`update`, (update: Uint8Array, origin: unknown) => {
        if (origin !== `server`) {
          console.log(`Yjs generated update: ${update.length} bytes`, update)
          sentUpdates.push(update)
        }
      })

      const provider1 = new DurableStreamsProvider({
        doc: doc1,
        documentStream: {
          url: `${baseUrl}/v1/stream/rooms/${roomId}`,
          transport: `sse`,
        },
        debug: true,
      })
      providers.push(provider1)

      await waitForSync(provider1)

      // Make changes
      const text1 = doc1.getText(`content`)
      text1.insert(0, `Hello SSE`)

      // Wait for send
      await new Promise((r) => setTimeout(r, 500))

      console.log(`Total updates sent: ${sentUpdates.length}`)
      for (let i = 0; i < sentUpdates.length; i++) {
        console.log(`Update ${i}: ${sentUpdates[i]!.length} bytes`)
      }

      // Read from stream directly
      const directResponse = await stream.stream({
        offset: `-1`,
        live: false,
      })
      const rawData = await directResponse.body()
      console.log(`Raw data in stream: ${rawData.length} bytes`, rawData)

      // Try to decode what's in the stream
      const streamDecoder = createDecoder(rawData)
      let decodedCount = 0
      while (hasContent(streamDecoder)) {
        try {
          const update = readVarUint8Array(streamDecoder)
          console.log(
            `Decoded update ${++decodedCount}: ${update.length} bytes`
          )
        } catch (err) {
          console.log(`Decode error after ${decodedCount} updates:`, err)
          break
        }
      }

      // Now read via SSE+base64 directly (not via provider) to see what's delivered
      console.log(`\n--- Reading via SSE+base64 ---`)
      const sseResponse = await stream.stream({
        offset: `-1`,
        live: `sse`,
        encoding: `base64`,
      })
      const sseChunks: Array<Uint8Array> = []
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`SSE timeout`)), 5000)
        sseResponse.subscribeBytes((chunk) => {
          console.log(
            `SSE chunk: ${chunk.data.length} bytes`,
            chunk.data,
            `upToDate: ${chunk.upToDate}`
          )
          sseChunks.push(chunk.data)
          if (chunk.upToDate) {
            clearTimeout(timeout)
            resolve()
          }
        })
      })
      const totalSSEBytes = sseChunks.reduce((sum, c) => sum + c.length, 0)
      console.log(`Total SSE bytes received: ${totalSSEBytes}`)

      // Second provider joins
      const doc2 = new Y.Doc()
      const provider2 = new DurableStreamsProvider({
        doc: doc2,
        documentStream: {
          url: `${baseUrl}/v1/stream/rooms/${roomId}`,
          transport: `sse`,
        },
        debug: true,
      })
      providers.push(provider2)

      await waitForSync(provider2)

      // Check if data synced
      const text2 = doc2.getText(`content`)
      expect(text2.toString()).toBe(`Hello SSE`)
    }, 15000)
  })
})

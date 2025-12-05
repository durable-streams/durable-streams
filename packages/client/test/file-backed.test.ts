/**
 * Tests for file-backed storage implementation.
 * Verifies correctness fixes from external review.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  DurableStreamTestServer,
  decodeStreamPath,
  encodeStreamPath,
} from "@durable-streams/server"
import { decode, encode } from "./support/test-helpers"
import type { FileBackedStreamStore } from "@durable-streams/server"

// ============================================================================
// Test fixture for file-backed server
// ============================================================================

let dataDir: string
let server: DurableStreamTestServer
let store: FileBackedStreamStore

beforeEach(async () => {
  // Create temp directory for each test
  dataDir = fs.mkdtempSync(path.join(tmpdir(), `durable-stream-test-`))
  server = new DurableStreamTestServer({ dataDir, port: 0 })
  await server.start()
  store = server.store as FileBackedStreamStore
})

afterEach(async () => {
  await server.stop()
  // Clean up temp directory
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ============================================================================
// Path Encoding Tests
// ============================================================================

describe(`Path Encoding`, () => {
  test(`should not misdetect hash suffix with base64url underscore`, () => {
    // Create a path that when base64url encoded ends with underscore + 16 chars
    // But those 16 chars are NOT a hex hash
    // Base64url uses [A-Za-z0-9_-], so we can construct a tricky case

    // This path will encode to something ending with _XXXXXXXXXXXXXXXX
    // where X are base64url chars (not necessarily hex)
    const trickyPath = `/stream/` + `a`.repeat(120) + `_test_value_data`

    const encoded = encodeStreamPath(trickyPath)
    const decoded = decodeStreamPath(encoded)

    expect(decoded).toBe(trickyPath)
  })

  test(`should use hash for very long paths`, () => {
    // Create a very long path that will get hashed
    const longPath = `/stream/` + `x`.repeat(250)

    const encoded = encodeStreamPath(longPath)

    // Should contain ~ separator for hash (not underscore)
    expect(encoded).toContain(`~`)

    // Should be truncated to reasonable length
    expect(encoded.length).toBeLessThan(200)

    // Note: Cannot decode hashed paths back to original since we've lost information
    // The hash is just to create a unique filesystem-safe identifier
  })
})

// ============================================================================
// Server Close Tests
// ============================================================================

describe(`Server Close`, () => {
  test(`should handle store.close() errors gracefully`, () => {
    const testServer = new DurableStreamTestServer({ dataDir, port: 0 })
    return testServer.start().then(() => {
      // Mock store.close() to throw
      const originalClose = testServer.store.close
      testServer.store.close = async () => {
        throw new Error(`Close failed intentionally`)
      }

      // Should reject with the error (not hang)
      return expect(testServer.stop())
        .rejects.toThrow(`Close failed intentionally`)
        .finally(() => {
          // Restore for cleanup
          testServer.store.close = originalClose
        })
    })
  })
})

// ============================================================================
// Clear + Recreate Tests
// ============================================================================

describe(`Clear and Recreate`, () => {
  test(`should not replay old messages after clear + recreate`, () => {
    store.create(`/test`, { contentType: `text/plain` })
    store.append(`/test`, encode(`old message`))

    // Clear all streams
    store.clear()

    // Recreate with same path
    store.create(`/test`, { contentType: `text/plain` })
    store.append(`/test`, encode(`new message`))

    const { messages } = store.read(`/test`)

    expect(messages).toHaveLength(1)
    expect(decode(messages[0].data)).toBe(`new message`)
  })

  test(`should handle multiple clear cycles without zombie data`, () => {
    for (let i = 0; i < 3; i++) {
      store.create(`/cycle`, { contentType: `text/plain` })
      store.append(`/cycle`, encode(`cycle ${i}`))

      const { messages } = store.read(`/cycle`)
      expect(messages).toHaveLength(1)
      expect(decode(messages[0].data)).toBe(`cycle ${i}`)

      store.clear()
    }
  })
})

// ============================================================================
// Read-Your-Writes Tests (In-Memory Buffer)
// ============================================================================

describe(`Read-Your-Writes Consistency`, () => {
  test(`should read message immediately after append`, () => {
    store.create(`/test`, { contentType: `text/plain` })
    const msg = store.append(`/test`, encode(`hello`))

    // Read immediately (before any fsync)
    const { messages } = store.read(`/test`)

    expect(messages).toHaveLength(1)
    expect(messages[0].offset).toBe(msg.offset)
    expect(decode(messages[0].data)).toBe(`hello`)
  })

  test(`should read multiple appends immediately`, () => {
    store.create(`/test`, { contentType: `text/plain` })

    store.append(`/test`, encode(`msg1`))
    store.append(`/test`, encode(`msg2`))
    store.append(`/test`, encode(`msg3`))

    // All should be readable immediately
    const { messages } = store.read(`/test`)

    expect(messages).toHaveLength(3)
    expect(decode(messages[0].data)).toBe(`msg1`)
    expect(decode(messages[1].data)).toBe(`msg2`)
    expect(decode(messages[2].data)).toBe(`msg3`)
  })

  test(`should notify long-poll immediately from buffer`, async () => {
    store.create(`/test`, { contentType: `text/plain` })
    store.append(`/test`, encode(`msg1`))

    const offset = store.getCurrentOffset(`/test`)!

    // Start long-poll at current offset
    const pollPromise = store.waitForMessages(`/test`, offset, 5000)

    // Append immediately (still in buffer, not fsynced)
    store.append(`/test`, encode(`msg2`))

    // Long-poll should resolve immediately from buffer
    const result = await pollPromise
    expect(result.timedOut).toBe(false)
    expect(result.messages).toHaveLength(1)
    expect(decode(result.messages[0].data)).toBe(`msg2`)
  })

  test(`should clear buffer on delete`, () => {
    store.create(`/test`, { contentType: `text/plain` })
    store.append(`/test`, encode(`data`))

    // Buffer should have messages
    const bufferBefore = (store as any).messageBuffers.get(`/test`)
    expect(bufferBefore).toHaveLength(1)

    store.delete(`/test`)

    // Buffer should be cleared
    const bufferAfter = (store as any).messageBuffers.has(`/test`)
    expect(bufferAfter).toBe(false)
  })

  test(`should clear buffer on clear()`, () => {
    store.create(`/test1`, { contentType: `text/plain` })
    store.create(`/test2`, { contentType: `text/plain` })
    store.append(`/test1`, encode(`data1`))
    store.append(`/test2`, encode(`data2`))

    // Buffers should have messages
    expect((store as any).messageBuffers.size).toBeGreaterThan(0)

    store.clear()

    // All buffers should be cleared
    expect((store as any).messageBuffers.size).toBe(0)
  })

  test(`should serve offset-based reads from buffer + disk`, () => {
    store.create(`/test`, { contentType: `text/plain` })
    store.append(`/test`, encode(`msg1`))

    const offset1 = store.getCurrentOffset(`/test`)!

    // Append more
    store.append(`/test`, encode(`msg2`))
    store.append(`/test`, encode(`msg3`))

    // Read from offset1 - should get msg2 and msg3 from buffer
    const { messages } = store.read(`/test`, offset1)

    expect(messages).toHaveLength(2)
    expect(decode(messages[0].data)).toBe(`msg2`)
    expect(decode(messages[1].data)).toBe(`msg3`)
  })
})

// ============================================================================
// Recovery and Crash Consistency Tests
// ============================================================================

describe(`Recovery and Crash Consistency`, () => {
  test(`should reconcile LMDB offset to file on recovery`, async () => {
    // Create initial server and append data
    const server1 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server1.start()

    server1.store.create(`/test`, { contentType: `text/plain` })
    server1.store.append(`/test`, encode(`msg1`))

    // Wait for fsync
    await new Promise((resolve) => setTimeout(resolve, 1100))

    // Manually corrupt LMDB to have a higher offset (simulating crash)
    const key = `stream:/test`
    const meta = (server1.store as any).db.get(key)
    meta.currentOffset = `0_1000` // Way ahead of actual file (which is 0_4)
    ;(server1.store as any).db.put(key, meta)

    await server1.stop()

    // Restart - should reconcile to file's true offset
    const server2 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server2.start()

    const reconciledMeta = (server2.store as any).db.get(key)
    expect(reconciledMeta.currentOffset).toBe(`0_4`) // Actual file offset for "msg1"

    // Should be able to append more
    server2.store.append(`/test`, encode(`msg2`))
    const { messages } = server2.store.read(`/test`)
    expect(messages).toHaveLength(2)

    await server2.stop()
  })

  test(`should handle truncated message in file`, async () => {
    // Create server and append multiple messages
    const server1 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server1.start()

    server1.store.create(`/test`, { contentType: `text/plain` })
    server1.store.append(`/test`, encode(`complete1`))
    server1.store.append(`/test`, encode(`complete2`))

    // Wait for fsync to disk
    await new Promise((resolve) => setTimeout(resolve, 1100))

    // Get stream metadata before stopping server
    const streamMeta = (server1.store as any).db.get(`stream:/test`)

    await server1.stop()

    // Manually truncate file mid-message (simulating crash during write)
    const segmentPath = path.join(
      dataDir,
      `streams`,
      streamMeta.directoryName,
      `segment_00000.log`
    )
    const content = fs.readFileSync(segmentPath)
    // Truncate last 3 bytes (partial message)
    fs.writeFileSync(segmentPath, content.subarray(0, content.length - 3))

    // Restart - should recover to last complete message
    const server2 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server2.start()

    const { messages } = server2.store.read(`/test`)
    // Should only have 1 complete message (complete1)
    // complete2 was truncated so should be discarded
    expect(messages).toHaveLength(1)
    expect(decode(messages[0].data)).toBe(`complete1`)

    await server2.stop()
  })

  test(`should remove stream from LMDB when file is missing`, async () => {
    // Create server and stream
    const server1 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server1.start()

    server1.store.create(`/test`, { contentType: `text/plain` })
    server1.store.append(`/test`, encode(`data`))

    // Wait for fsync
    await new Promise((resolve) => setTimeout(resolve, 1100))

    const streamMeta = (server1.store as any).db.get(`stream:/test`)
    const streamDir = path.join(dataDir, `streams`, streamMeta.directoryName)

    await server1.stop()

    // Delete the stream directory (but leave LMDB entry)
    fs.rmSync(streamDir, { recursive: true })

    // Restart - should detect missing file and remove from LMDB
    const server2 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server2.start()

    expect(server2.store.has(`/test`)).toBe(false)

    await server2.stop()
  })

  test(`should handle empty file gracefully`, async () => {
    const server1 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server1.start()

    server1.store.create(`/test`, { contentType: `text/plain` })
    // Don't append anything - file is empty

    await new Promise((resolve) => setTimeout(resolve, 100))
    await server1.stop()

    // Restart - should handle empty file
    const server2 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server2.start()

    expect(server2.store.has(`/test`)).toBe(true)
    const { messages } = server2.store.read(`/test`)
    expect(messages).toHaveLength(0)

    await server2.stop()
  })

  test(`should persist data across restart`, async () => {
    const server1 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server1.start()

    server1.store.create(`/persist`, { contentType: `text/plain` })
    server1.store.append(`/persist`, encode(`persisted message`))

    // Wait for fsync
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await server1.stop()

    // Restart and verify data persisted
    const server2 = new DurableStreamTestServer({ dataDir, port: 0 })
    await server2.start()

    expect(server2.store.has(`/persist`)).toBe(true)
    const { messages } = server2.store.read(`/persist`)
    expect(messages).toHaveLength(1)
    expect(decode(messages[0].data)).toBe(`persisted message`)

    await server2.stop()
  })
})

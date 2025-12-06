# Implementation Testing Guide

This document outlines testing approaches for Durable Streams server implementations that go beyond the black-box conformance tests. While the conformance test suite validates protocol compliance through the HTTP API, implementations should include additional white-box tests for reliability, correctness, and edge cases.

## Overview

The conformance test suite (`@durable-streams/conformance-tests`) validates:

- ✅ HTTP protocol compliance
- ✅ Correct header handling
- ✅ Offset and sequence number behavior
- ✅ Observable invariants (monotonicity, byte-exactness, etc.)

Implementation tests should validate:

- ⚠️ Internal state consistency
- ⚠️ Crash recovery and durability
- ⚠️ Race conditions and concurrency
- ⚠️ Resource management
- ⚠️ Storage backend correctness

## Critical Testing Areas

Based on 1.5 years of production experience with [ElectricSQL](https://electric-sql.com), which uses a similar streaming architecture, we've identified critical failure modes that require white-box testing.

### 1. Crash Recovery & Durability

**What to test:** That data persists correctly across crashes and incomplete writes.

**Why conformance tests can't cover this:** Can't simulate mid-operation crashes or corrupt internal files through HTTP API.

#### Test: Incomplete Write Recovery

```typescript
test("should recover from incomplete chunk write", async () => {
  const storage = new YourStorage()

  // Append some data
  await storage.append(streamId, chunk1)

  // Simulate crash by manually corrupting storage
  const chunkFile = storage.getChunkPath(streamId, offset)
  const fd = fs.openSync(chunkFile, "a")
  fs.writeSync(fd, Buffer.from([0xff, 0xff])) // Partial data
  fs.closeSync(fd)

  // Initialize new storage instance (simulates restart)
  const storage2 = new YourStorage()

  // Should recover cleanly, rolling back to last valid boundary
  const stream = await storage2.read(streamId, 0)
  expect(stream.data).toEqual(chunk1) // No corrupt data
  expect(stream.upToDate).toBe(true)
})
```

**Real bug from Electric:** [Issue #2073](https://github.com/electric-sql/electric/issues/2073) - After crash during large data load, shapes existed but contained no data.

#### Test: Idempotent Recovery

```typescript
test("should handle recovery idempotently", async () => {
  const storage = new YourStorage()

  // Append data
  await storage.append(streamId, chunk1)

  // Simulate crash and recovery multiple times
  for (let i = 0; i < 5; i++) {
    storage.close()
    const newStorage = new YourStorage()
    const stream = await newStorage.read(streamId, 0)
    expect(stream.data).toEqual(chunk1)
    storage = newStorage
  }
})
```

**What this catches:** Non-idempotent recovery that corrupts data on repeated restarts.

#### Test: Partial Flush Handling

```typescript
test("should handle partial flush to disk", async () => {
  const storage = new YourStorage()

  // Write multiple chunks
  await storage.append(streamId, chunk1)
  await storage.append(streamId, chunk2)
  await storage.append(streamId, chunk3)

  // Simulate partial flush (only chunk1 and chunk2 on disk)
  storage._simulatePartialFlush(2)

  // Crash and restart
  const storage2 = new YourStorage()

  // Should have chunk1 and chunk2, not chunk3
  const stream = await storage2.read(streamId, 0)
  expect(stream.chunks).toHaveLength(2)
})
```

**What this catches:** Buffering bugs where in-memory state diverges from persisted state.

### 2. Concurrent Access & Race Conditions

**What to test:** Thread-safety, file locking, and consistent reads during concurrent writes.

**Why conformance tests can't cover this:** Can't control thread interleaving or force specific race conditions.

#### Test: Concurrent Readers During Write

```typescript
test("should serve consistent data to concurrent readers during write", async () => {
  const storage = new YourStorage()

  // Start slow append in background
  const largeChunk = new Uint8Array(10 * 1024 * 1024)
  const appendPromise = storage.append(streamId, largeChunk)

  // Immediately start multiple concurrent readers
  const readers = []
  for (let i = 0; i < 10; i++) {
    readers.push(storage.read(streamId, 0))
  }

  const results = await Promise.all([appendPromise, ...readers])
  const readResults = results.slice(1)

  // All readers should see consistent state
  // Either empty (append not visible) OR complete chunk (append done)
  // NEVER partial data
  readResults.forEach((result) => {
    expect([0, largeChunk.length]).toContain(result.data.length)
  })
})
```

**Real bug from Electric:** [Concurrent stream test](https://github.com/electric-sql/electric/blob/main/packages/sync-service/test/electric/concurrent_stream_test.exs) - readers could see torn/partial writes.

#### Test: File Deletion During Read

```typescript
test("should handle file deletion during active read stream", async () => {
  const storage = new YourStorage()

  await storage.append(streamId, chunk1)
  await storage.append(streamId, chunk2)

  // Start streaming read
  const stream = storage.createReadStream(streamId, 0)

  // Read first chunk
  const first = await stream.read()
  expect(first.data).toEqual(chunk1)

  // Delete files while stream is active
  await storage.delete(streamId)

  // Should handle gracefully (return empty/error, not crash)
  const second = await stream.read()
  expect([null, undefined, new Uint8Array()]).toContain(second)
})
```

**Real bug from Electric:** [pure_file_storage_test.exs](https://github.com/electric-sql/electric/blob/main/packages/sync-service/test/electric/shape_cache/pure_file_storage_test.exs#L466) - file deletion during streaming caused crashes.

#### Test: LSN/Offset Persistence Races

```typescript
test("should persist offsets atomically", async () => {
  const storage = new YourStorage()

  // Concurrent appends
  const promises = []
  for (let i = 0; i < 100; i++) {
    promises.push(storage.append(streamId, new Uint8Array([i])))
  }

  const offsets = await Promise.all(promises)

  // All offsets should be unique and monotonic
  const uniqueOffsets = new Set(offsets.map((o) => o.toString()))
  expect(uniqueOffsets.size).toBe(100)

  // Verify offsets are actually persisted correctly
  for (const offset of offsets) {
    const metadata = await storage.getOffsetMetadata(streamId, offset)
    expect(metadata).toBeDefined()
    expect(metadata.offset).toEqual(offset)
  }
})
```

**Real bug from Electric:** [Issue #2470](https://electric-sql.com/blog/2025/08/04/reliability-sprint) - LSN persistence race conditions in WAL processing.

### 3. Resource Management & Cleanup

**What to test:** File handle leaks, memory leaks, proper cleanup of resources.

**Why conformance tests can't cover this:** Can't inspect internal resource allocation.

#### Test: No File Handle Leaks

```typescript
test("should not leak file handles", async () => {
  const storage = new YourStorage()
  const initialHandles = process._getActiveHandles().length

  // Create and delete many streams
  for (let i = 0; i < 100; i++) {
    const id = `stream-${i}`
    await storage.create(id)
    await storage.append(id, chunk1)
    await storage.read(id, 0)
    await storage.delete(id)
  }

  // Force garbage collection
  if (global.gc) global.gc()
  await new Promise((resolve) => setTimeout(resolve, 100))

  const finalHandles = process._getActiveHandles().length
  expect(finalHandles).toBeLessThanOrEqual(initialHandles + 5)
})
```

**Real bug from Electric:** [Issue #2616](https://electric-sql.com/blog/2025/08/04/reliability-sprint) - Shape cleanup wasn't deleting orphaned handles.

#### Test: Complete Cleanup on Delete

```typescript
test("should completely remove all files on delete", async () => {
  const storage = new YourStorage()

  await storage.create(streamId)
  await storage.append(streamId, chunk1)
  await storage.append(streamId, chunk2)

  // Record all files created
  const files = storage.listFiles(streamId)
  expect(files.length).toBeGreaterThan(0)

  // Delete stream
  await storage.delete(streamId)

  // Verify ALL files removed
  files.forEach((file) => {
    expect(fs.existsSync(file)).toBe(false)
  })

  // Verify metadata cleaned up
  expect(await storage.exists(streamId)).toBe(false)
})
```

**Real bug from Electric:** [Issue #2662](https://electric-sql.com/blog/2025/08/04/reliability-sprint) - File cleanup race conditions left orphaned files.

#### Test: LRU Eviction

```typescript
test("should evict inactive streams when memory pressure", async () => {
  const storage = new YourStorage({ maxMemoryMB: 100 })

  // Create many streams to exceed memory limit
  const streams = []
  for (let i = 0; i < 1000; i++) {
    streams.push(`stream-${i}`)
    await storage.create(streams[i])
    await storage.append(streams[i], largeChunk)
  }

  // Check memory usage
  const memoryUsage = storage.getMemoryUsage()
  expect(memoryUsage).toBeLessThan(100 * 1024 * 1024)

  // Old streams should be evicted (but data still accessible from disk)
  const oldStream = await storage.read(streams[0], 0)
  expect(oldStream.data).toBeDefined()
})
```

**Real bug from Electric:** [Issue #2514](https://electric-sql.com/blog/2025/08/04/reliability-sprint) - Inactive shapes not automatically evicted.

### 4. Storage Backend Correctness

**What to test:** That different storage backends (in-memory, file, R2, S3, etc.) behave identically.

**Why conformance tests can't cover this:** Protocol tests only see HTTP interface, not storage layer.

#### Test: Cross-Backend Compliance

```typescript
describe.each([
  ["InMemoryStorage", InMemoryStorage],
  ["FileStorage", FileStorage],
  ["R2Storage", R2Storage],
])("%s compliance", (name, StorageClass) => {
  test("append and read", async () => {
    const storage = new StorageClass()
    await storage.create(streamId)
    await storage.append(streamId, chunk1)

    const result = await storage.read(streamId, 0)
    expect(result.data).toEqual(chunk1)
  })

  test("offset generation", async () => {
    const storage = new StorageClass()
    await storage.create(streamId)

    const offset1 = await storage.append(streamId, chunk1)
    const offset2 = await storage.append(streamId, chunk2)

    expect(offset2 > offset1).toBe(true)
  })

  // ... all other storage interface tests
})
```

**Pattern from Electric:** [storage_implementations_test.exs](https://github.com/electric-sql/electric/blob/main/packages/sync-service/test/electric/shape_cache/storage_implementations_test.exs) - Same test suite runs against all storage backends.

#### Test: Migration Between Backends

```typescript
test("should migrate data between storage backends", async () => {
  const fileStorage = new FileStorage()
  await fileStorage.create(streamId)
  await fileStorage.append(streamId, chunk1)
  await fileStorage.append(streamId, chunk2)

  // Export data
  const exported = await fileStorage.export(streamId)

  // Import to different backend
  const r2Storage = new R2Storage()
  await r2Storage.import(streamId, exported)

  // Should have identical data
  const original = await fileStorage.read(streamId, 0)
  const migrated = await r2Storage.read(streamId, 0)
  expect(migrated.data).toEqual(original.data)
})
```

### 5. Initialization & Startup

**What to test:** System initialization order, preventing races during startup.

**Why conformance tests can't cover this:** Can't control startup sequence through HTTP.

#### Test: Startup Synchronization

```typescript
test("should not process writes before full initialization", async () => {
  const storage = new YourStorage()

  // Simulate slow initialization
  const initPromise = storage.initialize({ simulateSlowInit: true })

  // Try to write before init completes
  const writePromise = storage.append(streamId, chunk1)

  await initPromise

  // Write should wait for init, not proceed prematurely
  const offset = await writePromise
  expect(offset).toBeDefined()

  // Verify storage is consistent
  const data = await storage.read(streamId, 0)
  expect(data.data).toEqual(chunk1)
})
```

**Real bug from Electric:** [Issues #2576, #2531](https://electric-sql.com/blog/2025/08/04/reliability-sprint) - Replication could process changes before full system initialization.

### 6. Property-Based Testing

**What to test:** Invariants hold across randomized operations.

**Why conformance tests can't cover this:** Limited to specific test cases, not exhaustive exploration.

#### Test: Random Operation Sequences

```typescript
import fc from "fast-check"

test("maintains invariants across random operations", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.oneof(
          fc.record({
            op: fc.constant("append"),
            data: fc.uint8Array({ maxLength: 1000 }),
          }),
          fc.record({ op: fc.constant("read"), offset: fc.string() }),
          fc.record({ op: fc.constant("delete") })
        ),
        { maxLength: 100 }
      ),
      async (operations) => {
        const storage = new YourStorage()
        await storage.create(streamId)

        const expectedData = []

        for (const op of operations) {
          if (op.op === "append") {
            await storage.append(streamId, op.data)
            expectedData.push(...op.data)
          } else if (op.op === "read") {
            const result = await storage.read(streamId, 0)
            // Should never crash, always return valid data
            expect(result.data).toBeDefined()
          } else if (op.op === "delete") {
            await storage.delete(streamId)
            expectedData.length = 0
            await storage.create(streamId) // Recreate for next ops
          }
        }

        // Final state should match expected
        const final = await storage.read(streamId, 0)
        expect(new Uint8Array(final.data)).toEqual(new Uint8Array(expectedData))
      }
    ),
    { numRuns: 100 }
  )
})
```

**Pattern from Electric:** [pg_expression_generator.ex](https://github.com/electric-sql/electric/blob/main/packages/sync-service/test/support/pg_expression_generator.ex) - Property-based testing for expression evaluation.

#### Test: Offset Wraparound

```typescript
test("handles offset wraparound correctly", async () => {
  const storage = new YourStorage()

  // If using numeric offsets, test near MAX_SAFE_INTEGER
  await storage.create(streamId)
  storage._setNextOffset(streamId, Number.MAX_SAFE_INTEGER - 10)

  // Append across boundary
  for (let i = 0; i < 20; i++) {
    const offset = await storage.append(streamId, new Uint8Array([i]))
    expect(offset).toBeDefined()
  }

  // Should still maintain monotonicity (wrapping or error)
  const allOffsets = await storage.listOffsets(streamId)
  for (let i = 1; i < allOffsets.length; i++) {
    expect(compareOffsets(allOffsets[i], allOffsets[i - 1])).toBeGreaterThan(0)
  }
})
```

**Pattern from Electric:** [xid_test.exs](https://github.com/electric-sql/electric/blob/main/packages/sync-service/test/electric/postgres/xid_test.exs) - Transaction ID wraparound handling.

## Testing Tools & Utilities

### Chaos Engineering Helpers

```typescript
class ChaoticStorage {
  constructor(realStorage, options = {}) {
    this.storage = realStorage
    this.failureRate = options.failureRate || 0.1
    this.delayMs = options.delayMs || 0
  }

  async append(streamId, data) {
    if (Math.random() < this.failureRate) {
      throw new Error("Simulated failure")
    }
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs))
    }
    return this.storage.append(streamId, data)
  }

  // ... wrap all methods with chaos injection
}

test("handles transient failures gracefully", async () => {
  const chaoticStorage = new ChaoticStorage(new FileStorage(), {
    failureRate: 0.3,
    delayMs: 100,
  })

  // Should retry and eventually succeed
  let successCount = 0
  for (let i = 0; i < 10; i++) {
    try {
      await chaoticStorage.append(streamId, chunk1)
      successCount++
    } catch (err) {
      // Expected occasional failures
    }
  }

  expect(successCount).toBeGreaterThan(0)
})
```

### File Corruption Utilities

```typescript
function corruptFile(path, options = {}) {
  const { position = "end", bytes = 2 } = options
  const fd = fs.openSync(path, "r+")
  const stat = fs.fstatSync(fd)

  const pos =
    position === "end"
      ? stat.size
      : position === "middle"
        ? Math.floor(stat.size / 2)
        : 0

  fs.writeSync(fd, Buffer.alloc(bytes, 0xff), 0, bytes, pos)
  fs.closeSync(fd)
}

test("recovers from corrupted chunk file", async () => {
  const storage = new FileStorage()
  await storage.append(streamId, chunk1)
  await storage.append(streamId, chunk2)

  // Corrupt second chunk
  const chunkFile = storage.getChunkPath(streamId, offset2)
  corruptFile(chunkFile, { position: "middle", bytes: 10 })

  // Restart storage
  const storage2 = new FileStorage()

  // Should detect corruption and handle gracefully
  const result = await storage2.read(streamId, 0)
  // Either: (a) only returns chunk1, or (b) throws clear error
  expect([chunk1, new Error()]).toContainEqual(result.data || result)
})
```

## Test Execution Recommendations

1. **Run conformance tests first** - Validate protocol compliance before internal testing
2. **Separate test suites** - Keep implementation tests separate from protocol tests
3. **CI/CD integration** - Run both test suites on every commit
4. **Load testing** - Run property-based tests with high iteration counts in nightly builds
5. **Chaos testing** - Periodically run chaos monkey tests to find race conditions

## Resources & References

- [ElectricSQL Reliability Sprint](https://electric-sql.com/blog/2025/08/04/reliability-sprint) - 120 days of hardening, 200+ bugs fixed
- [Electric GitHub Issues](https://github.com/electric-sql/electric/issues?q=is%3Aissue+label%3Abug+) - Real production bugs
- [Electric Test Suite](https://github.com/electric-sql/electric/tree/main/packages/sync-service/test) - Implementation test patterns
- [Durable Streams Protocol](./PROTOCOL.md) - Protocol specification
- [Conformance Tests](./packages/conformance-tests) - Black-box test suite

## Contributing

If you discover implementation bugs or testing patterns that should be included in this guide, please open a PR or issue on the [Durable Streams repository](https://github.com/durable-streams/durable-streams).

---

**Remember:** Conformance tests validate that you speak the protocol correctly. Implementation tests validate that your internal machinery doesn't break under pressure. Both are essential for production-ready systems.

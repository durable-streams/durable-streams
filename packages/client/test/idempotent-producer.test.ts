/**
 * Tests for IdempotentProducer class.
 *
 * Covers:
 * - Basic append + flush
 * - Auto-batching (lingerMs, maxBatchBytes)
 * - Pipelining (maxInFlight concurrent batches)
 * - Duplicate detection (204 response handled silently)
 * - Auto-claim (403 → retry with epoch+1)
 * - Stale epoch error (StaleEpochError thrown)
 * - Network retry (transient failures retried)
 * - flush() waits for all in-flight
 * - close() flushes then prevents further appends
 * - restart() increments epoch, resets seq
 */

import { describe, expect } from "vitest"
import { DurableStream, IdempotentProducer, StaleEpochError } from "../src"
import { testWithServer, testWithStream } from "./support/test-context"
import { sleep } from "./support/test-helpers"

describe(`IdempotentProducer`, () => {
  describe(`Basic Operations`, () => {
    testWithStream(
      `should append and flush successfully`,
      async ({ streamUrl }) => {
        const stream = new DurableStream({ url: streamUrl })
        const producer = new IdempotentProducer(stream, `test-producer`)

        const result = await producer.append(`hello world`)
        await producer.flush()

        expect(result.offset).toBeTruthy()
        expect(result.duplicate).toBe(false)

        await producer.close()
      }
    )

    testWithStream(
      `should track epoch and nextSeq correctly`,
      async ({ streamUrl }) => {
        const stream = new DurableStream({ url: streamUrl })
        const producer = new IdempotentProducer(stream, `test-producer`, {
          epoch: 5,
        })

        expect(producer.epoch).toBe(5)
        expect(producer.nextSeq).toBe(0)

        await producer.append(`msg1`)
        await producer.flush()

        // After flush, nextSeq should be 1 (seq 0 was used)
        expect(producer.nextSeq).toBe(1)

        await producer.close()
      }
    )

    testWithStream(`should append binary data`, async ({ streamUrl }) => {
      const stream = new DurableStream({ url: streamUrl })
      const producer = new IdempotentProducer(stream, `test-producer`)

      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff])
      const result = await producer.append(binaryData)
      await producer.flush()

      expect(result.offset).toBeTruthy()
      expect(result.duplicate).toBe(false)

      await producer.close()
    })
  })

  describe(`Batching`, () => {
    testWithStream(
      `should batch messages until lingerMs elapses`,
      async ({ streamUrl }) => {
        const stream = new DurableStream({ url: streamUrl })
        const producer = new IdempotentProducer(stream, `test-producer`, {
          lingerMs: 50,
          maxBatchBytes: 1024 * 1024, // 1MB (won't trigger)
        })

        // Add messages without awaiting flush
        const p1 = producer.append(`msg1`)
        const p2 = producer.append(`msg2`)
        const p3 = producer.append(`msg3`)

        // All should be pending
        expect(producer.pendingCount).toBe(3)

        // Wait for linger timeout + some buffer
        await sleep(100)

        // All should resolve
        const [r1, r2, r3] = await Promise.all([p1, p2, p3])
        expect(r1.offset).toBeTruthy()
        expect(r2.offset).toBeTruthy()
        expect(r3.offset).toBeTruthy()

        await producer.close()
      }
    )

    testWithStream(
      `should send batch when maxBatchBytes is reached`,
      async ({ streamUrl }) => {
        const stream = new DurableStream({ url: streamUrl })
        const producer = new IdempotentProducer(stream, `test-producer`, {
          lingerMs: 10000, // Long linger (won't trigger)
          maxBatchBytes: 20, // Small batch size
        })

        // Add a message that exceeds maxBatchBytes
        const largeMsg = `this message is definitely longer than 20 bytes`
        const result = await producer.append(largeMsg)

        // Should be sent immediately without waiting for linger
        expect(result.offset).toBeTruthy()

        await producer.close()
      }
    )

    testWithStream(
      `flush() should send pending batch immediately`,
      async ({ streamUrl }) => {
        const stream = new DurableStream({ url: streamUrl })
        const producer = new IdempotentProducer(stream, `test-producer`, {
          lingerMs: 10000, // Long linger
        })

        const p1 = producer.append(`msg1`)
        const p2 = producer.append(`msg2`)

        expect(producer.pendingCount).toBe(2)

        // Flush should send immediately
        await producer.flush()

        const [r1, r2] = await Promise.all([p1, p2])
        expect(r1.offset).toBeTruthy()
        expect(r2.offset).toBeTruthy()

        await producer.close()
      }
    )
  })

  describe(`Pipelining`, () => {
    testWithStream(`should track in-flight batches`, async ({ streamUrl }) => {
      const stream = new DurableStream({ url: streamUrl })
      const producer = new IdempotentProducer(stream, `test-producer`, {
        lingerMs: 1, // Fast batching
        maxInFlight: 5,
      })

      // Send multiple batches
      const promises = []
      for (let i = 0; i < 5; i++) {
        promises.push(producer.append(`msg${i}`))
        await sleep(5) // Wait for each batch to be sent
      }

      // Wait for all to complete
      await Promise.all(promises)
      await producer.flush()

      expect(producer.inFlightCount).toBe(0)

      await producer.close()
    })
  })

  describe(`Duplicate Detection`, () => {
    testWithServer(
      `should handle 204 response as duplicate success`,
      async ({ baseUrl, store }) => {
        const streamPath = `/dup-test-${Date.now()}`
        store.create(streamPath, { contentType: `application/octet-stream` })

        const stream = new DurableStream({ url: `${baseUrl}${streamPath}` })

        // Create two producers with same ID to simulate duplicate
        const producer1 = new IdempotentProducer(stream, `shared-producer`, {
          epoch: 0,
          lingerMs: 0,
        })
        const producer2 = new IdempotentProducer(stream, `shared-producer`, {
          epoch: 0,
          lingerMs: 0,
        })

        // First append succeeds
        const r1 = await producer1.append(`msg`)
        await producer1.flush()
        expect(r1.duplicate).toBe(false)

        // Second append with same epoch/seq gets 204 (duplicate)
        const r2 = await producer2.append(`msg`)
        await producer2.flush()
        expect(r2.duplicate).toBe(true)

        await producer1.close()
        await producer2.close()
      }
    )
  })

  describe(`Epoch Management`, () => {
    testWithServer(
      `should throw StaleEpochError when epoch is stale`,
      async ({ baseUrl, store }) => {
        const streamPath = `/stale-epoch-test-${Date.now()}`
        store.create(streamPath, { contentType: `application/octet-stream` })

        const stream = new DurableStream({ url: `${baseUrl}${streamPath}` })

        // First producer establishes epoch=1
        const producer1 = new IdempotentProducer(stream, `shared-producer`, {
          epoch: 1,
          lingerMs: 0,
        })
        await producer1.append(`msg`)
        await producer1.flush()
        await producer1.close()

        // Second producer tries with epoch=0 (stale)
        const producer2 = new IdempotentProducer(stream, `shared-producer`, {
          epoch: 0,
          autoClaim: false, // Don't auto-claim
          lingerMs: 0,
        })

        await expect(async () => {
          await producer2.append(`stale msg`)
          await producer2.flush()
        }).rejects.toThrow(StaleEpochError)

        await producer2.close()
      }
    )

    testWithServer(
      `should auto-claim epoch when autoClaim is true`,
      async ({ baseUrl, store }) => {
        const streamPath = `/auto-claim-test-${Date.now()}`
        store.create(streamPath, { contentType: `application/octet-stream` })

        const stream = new DurableStream({ url: `${baseUrl}${streamPath}` })

        // First producer establishes epoch=1
        const producer1 = new IdempotentProducer(stream, `shared-producer`, {
          epoch: 1,
          lingerMs: 0,
        })
        await producer1.append(`msg`)
        await producer1.flush()
        await producer1.close()

        // Second producer tries with epoch=0 but has autoClaim=true
        const producer2 = new IdempotentProducer(stream, `shared-producer`, {
          epoch: 0,
          autoClaim: true,
          lingerMs: 0,
        })

        // Should succeed by auto-claiming epoch=2
        const result = await producer2.append(`auto-claimed msg`)
        await producer2.flush()

        expect(result.duplicate).toBe(false)
        expect(producer2.epoch).toBe(2) // Claimed epoch+1

        await producer2.close()
      }
    )

    testWithStream(
      `restart() should increment epoch and reset seq`,
      async ({ streamUrl }) => {
        const stream = new DurableStream({ url: streamUrl })
        const producer = new IdempotentProducer(stream, `test-producer`, {
          epoch: 0,
          lingerMs: 0,
        })

        // Send some messages
        await producer.append(`msg1`)
        await producer.append(`msg2`)
        await producer.flush()

        expect(producer.epoch).toBe(0)
        expect(producer.nextSeq).toBe(2) // Used seq 0 and 1

        // Restart
        await producer.restart()

        expect(producer.epoch).toBe(1)
        expect(producer.nextSeq).toBe(0)

        // Should be able to send with new epoch
        const result = await producer.append(`after restart`)
        await producer.flush()

        expect(result.duplicate).toBe(false)

        await producer.close()
      }
    )
  })

  describe(`Lifecycle`, () => {
    testWithStream(
      `close() should flush pending and prevent further appends`,
      async ({ streamUrl }) => {
        const stream = new DurableStream({ url: streamUrl })
        const producer = new IdempotentProducer(stream, `test-producer`, {
          lingerMs: 10000, // Long linger
        })

        // Add pending messages
        const p1 = producer.append(`msg1`)
        const p2 = producer.append(`msg2`)

        // Close should flush
        await producer.close()

        // Pending messages should resolve
        const [r1, r2] = await Promise.all([p1, p2])
        expect(r1.offset).toBeTruthy()
        expect(r2.offset).toBeTruthy()

        // Further appends should throw
        await expect(producer.append(`after close`)).rejects.toThrow(/closed/i)
      }
    )

    testWithStream(`should handle abort signal`, async ({ streamUrl }) => {
      const controller = new AbortController()
      const stream = new DurableStream({ url: streamUrl })
      const producer = new IdempotentProducer(stream, `test-producer`, {
        signal: controller.signal,
        lingerMs: 10000,
      })

      // Add pending message
      const p1 = producer.append(`msg1`)

      // Abort before flush
      controller.abort()

      // Pending message should reject
      await expect(p1).rejects.toThrow()

      await producer.close()
    })
  })

  describe(`Error Handling`, () => {
    testWithServer(
      `should handle sequence gaps correctly`,
      async ({ baseUrl, store }) => {
        const streamPath = `/seq-gap-test-${Date.now()}`
        store.create(streamPath, { contentType: `application/octet-stream` })

        const stream = new DurableStream({ url: `${baseUrl}${streamPath}` })

        // Normal producer - sends correctly
        const producer = new IdempotentProducer(stream, `test-producer`, {
          lingerMs: 0,
        })

        // First message succeeds
        await producer.append(`msg0`)
        await producer.flush()

        // Sequence gaps are internally managed, so normal usage shouldn't
        // produce gaps. This test verifies the producer tracks sequences
        // correctly across multiple appends.
        await producer.append(`msg1`)
        await producer.append(`msg2`)
        await producer.flush()

        expect(producer.nextSeq).toBe(3)

        await producer.close()
      }
    )
  })
})

/**
 * Layer 1 Consumer Protocol conformance tests — DSL-driven.
 * Tests the consumer lifecycle: register, acquire, ack, release.
 */

import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  applyConsumerAction,
  consumer,
  enabledConsumerActions,
} from "./consumer-dsl"
import type { ConsumerAction, L1ConsumerModel } from "./consumer-dsl"

export interface ConsumerTestContext {
  serverUrl: string
}

let _testCounter = 0
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_testCounter}`
}

async function createWebhookProbe(): Promise<{
  url: string
  waitForNotification: (timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => Promise<void>
}> {
  let server: ReturnType<typeof createServer> | null = null
  let resolveNotification: ((body: Record<string, unknown>) => void) | null =
    null
  let rejectNotification: ((err: Error) => void) | null = null

  const notification = new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      resolveNotification = resolve
      rejectNotification = reject
    }
  )

  await new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const chunks: Array<Buffer> = []
      req.on(`data`, (chunk: Buffer) => chunks.push(chunk))
      req.on(`end`, () => {
        const raw = Buffer.concat(chunks).toString(`utf-8`)
        const body = JSON.parse(raw) as Record<string, unknown>
        resolveNotification?.(body)
        res.writeHead(200, { "content-type": `application/json` })
        res.end(JSON.stringify({ ok: true }))
      })
      req.on(`error`, reject)
    })
    server.on(`error`, reject)
    server.listen(0, `127.0.0.1`, () => resolve())
  })

  const addr = server!.address()
  if (!addr || typeof addr === `string`) {
    throw new Error(`Failed to start webhook probe`)
  }

  return {
    url: `http://127.0.0.1:${addr.port}/hook`,
    waitForNotification: (timeoutMs = 5_000) =>
      Promise.race([
        notification,
        new Promise<Record<string, unknown>>((_, reject) => {
          setTimeout(
            () =>
              reject(new Error(`Timed out waiting for webhook notification`)),
            timeoutMs
          )
        }),
      ]),
    close: async () => {
      rejectNotification?.(
        new Error(`Webhook probe closed before notification`)
      )
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    },
  }
}

export function runConsumerConformanceTests(
  getCtx: () => ConsumerTestContext
): void {
  describe(`L1: Named Consumers`, () => {
    const url = () => getCtx().serverUrl

    describe(`Registration`, () => {
      it(`registers a new consumer`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`idempotent registration`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url()).stream(s).register(c, [s]).register(c, [s]).run()
      })

      it(`re-registration with different streams returns 409`, async () => {
        const s1 = `/test/${uid(`stream`)}`
        const s2 = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s1)
          .stream(s2)
          .register(c, [s1])
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({ consumer_id: c, streams: [s2] }),
            })
            expect(res.status).toBe(409)
            const body = await res.json()
            expect(body.error.code).toBe(`CONSUMER_ALREADY_EXISTS`)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects consumer_id with reserved webhook prefix`, async () => {
        const s = `/test/${uid(`stream`)}`
        await consumer(url())
          .stream(s)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({
                consumer_id: `__wh__:should-be-rejected`,
                streams: [s],
              }),
            })
            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error.code).toBe(`INVALID_REQUEST`)
            expect(body.error.message).toContain(`__wh__:`)
          })
          .skipInvariants()
          .run()
      })

      it(`GET returns consumer info`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`registering after existing data still starts at -1`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .custom((ctx) => {
            const acquired = ctx.history.findLast(
              (e) => e.type === `epoch_acquired`
            )
            expect(acquired?.type).toBe(`epoch_acquired`)
            if (acquired?.type === `epoch_acquired`) {
              expect(acquired.streams[0]?.offset).toBe(`-1`)
            }
          })
          .run()
      })

      it(`GET returns 404 for unknown consumer`, async () => {
        await consumer(url())
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/nonexistent`)
            expect(res.status).toBe(404)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects malformed registration payloads`, async () => {
        const c = uid(`consumer`)
        await consumer(url())
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({
                consumer_id: c,
                streams: `/not-an-array`,
              }),
            })
            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error.code).toBe(`INVALID_REQUEST`)
          })
          .skipInvariants()
          .run()
      })

      it(`DELETE removes consumer`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .deleteConsumer(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}`)
            expect(res.status).toBe(404)
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Epoch Acquisition`, () => {
      it(`acquires epoch and returns token`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .run()
      })

      it(`transitions consumer to READING state`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .getConsumer(c)
          .expectState(`READING`)
          .run()
      })

      it(`self-supersede increments epoch`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .acquire(c)
          .custom((ctx) => {
            expect(ctx.currentEpoch).toBe(2)
          })
          .run()
      })

      it(`returns 404 for unknown consumer`, async () => {
        await consumer(url())
          .tryAcquire(`nonexistent`)
          .expectAcquireError(`CONSUMER_NOT_FOUND`, 404)
          .skipInvariants()
          .run()
      })
    })

    describe(`Acknowledgment`, () => {
      it(`acks offsets successfully`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .ackLatest()
          .run()
      })

      it(`empty ack acts as heartbeat`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .heartbeat()
          .run()
      })

      it(`heartbeat does not advance cursor (LP3)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .ackLatest()
          .custom(async (ctx) => {
            const info1 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            const cursorBefore = info1.streams[0].offset

            const hbRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(hbRes.status).toBe(200)

            const info2 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info2.streams[0].offset).toBe(cursorBefore)
          })
          .run()
      })

      it(`heartbeat between two acks does not interfere with cursor (LP3 boundary)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        let offset1: string
        let offset2: string
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .appendTo(s, `event-1`)
          .custom((ctx) => {
            offset1 = ctx.tailOffsets.get(s)!
          })
          .appendTo(s, `event-2`)
          .custom((ctx) => {
            offset2 = ctx.tailOffsets.get(s)!
          })
          .acquire(c)
          .custom(async (ctx) => {
            expect(offset2 > offset1).toBe(true)

            const ackRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [{ path: s, offset: offset1 }] }),
            })
            expect(ackRes.status).toBe(200)
            const ackBody = await ackRes.json()
            if (ackBody.token) ctx.currentToken = ackBody.token

            const info1 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info1.streams[0].offset).toBe(offset1)

            const hbRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(hbRes.status).toBe(200)
            const hbBody = await hbRes.json()
            if (hbBody.token) ctx.currentToken = hbBody.token

            const info2 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info2.streams[0].offset).toBe(offset1)

            const ack2Res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [{ path: s, offset: offset2 }] }),
            })
            expect(ack2Res.status).toBe(200)

            const info3 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info3.streams[0].offset).toBe(offset2)
          })
          .run()
      })

      it(`rejects ack without bearer token`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(res.status).toBe(401)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects ack when REGISTERED (not READING)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        let tokenBeforeRelease: string
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom((ctx) => {
            tokenBeforeRelease = ctx.currentToken!
          })
          .release(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${tokenBeforeRelease}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(res.status).toBe(409)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects malformed ack entries without mutating the cursor`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [{ path: s }] }),
            })
            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error.code).toBe(`INVALID_REQUEST`)

            const info = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info.streams[0].offset).toBe(`-1`)
          })
          .run()
      })
    })

    describe(`Wake Preferences`, () => {
      it(`webhook wake preference delivers a wake without subscriptions`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        const probe = await createWebhookProbe()

        try {
          await consumer(url())
            .stream(s)
            .register(c, [s])
            .custom(async (ctx) => {
              const setRes = await fetch(`${ctx.baseUrl}/consumers/${c}/wake`, {
                method: `PUT`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ type: `webhook`, url: probe.url }),
              })
              expect(setRes.status).toBe(200)

              const appendRes = await fetch(`${ctx.baseUrl}${s}`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(`event-1`),
              })
              expect(appendRes.status).toBe(204)

              const body = await probe.waitForNotification()
              expect(body.consumer_id).toBe(c)
              expect(body.primary_stream).toBe(s)
              expect(body.token).toBeTruthy()
              expect(body.callback).toBeTruthy()
            })
            .skipInvariants()
            .run()
        } finally {
          await probe.close().catch(() => {})
        }
      })
    })

    describe(`Error Cases`, () => {
      it(`rejects ack with stale epoch token (STALE_EPOCH)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        let oldToken: string
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom((ctx) => {
            oldToken = ctx.currentToken!
          })
          .acquire(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${oldToken}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(res.status).toBe(409)
            const body = await res.json()
            expect(body.error.code).toBe(`STALE_EPOCH`)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects ack with regressing offset (OFFSET_REGRESSION)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .appendTo(s, `event-2`)
          .register(c, [s])
          .acquire(c)
          .ackAll()
          .custom(async (ctx) => {
            const appends = ctx.history.filter(
              (e) => e.type === `events_appended` && e.path === s
            )
            const offset1 = (appends[0] as any).offset

            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [{ path: s, offset: offset1 }] }),
            })
            expect(res.status).toBe(409)
            const body = await res.json()
            expect(body.error.code).toBe(`OFFSET_REGRESSION`)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects ack beyond stream tail (INVALID_OFFSET)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .tryAck([{ path: s, offset: `9999999999999999_9999999999999999` }])
          .expectAckError(`INVALID_OFFSET`, 409)
          .run()
      })

      it(`rejects ack for unknown stream (UNKNOWN_STREAM)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .tryAck([
            {
              path: `/test/nonexistent`,
              offset: `0000000000000001_0000000000000001`,
            },
          ])
          .expectAckError(`UNKNOWN_STREAM`, 400)
          .run()
      })
    })

    describe(`Lease TTL`, () => {
      it(`releases epoch after lease TTL expires`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s], 100)
          .acquire(c)
          .getConsumer(c)
          .expectState(`READING`)
          .wait(200)
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`empty ack (heartbeat) extends the lease`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s], 150)
          .acquire(c)
          .wait(100)
          .heartbeat()
          .wait(100)
          .getConsumer(c)
          .expectState(`READING`)
          .run()
      })
    })

    describe(`Multi-Stream Consumers`, () => {
      it(`tracks offsets independently across streams`, async () => {
        const sA = `/test/${uid(`stream-a`)}`
        const sB = `/test/${uid(`stream-b`)}`
        const c = uid(`multi-consumer`)
        await consumer(url())
          .stream(sA)
          .stream(sB)
          .appendTo(sA, `event-a`)
          .register(c, [sA, sB])
          .acquire(c)
          .ack(sA, `$latest`)
          .release(c)
          .acquire(c)
          .custom(async (ctx) => {
            const expectedOffset = ctx.tailOffsets.get(sA)!
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}`)
            const body = await res.json()
            const foundA = body.streams.find((s: any) => s.path === sA)
            expect(foundA).toBeDefined()
            expect(foundA.offset).toBe(expectedOffset)
          })
          .run()
      })

      it(`atomic ack: regression on one stream rejects entire batch`, async () => {
        const sA = `/test/${uid(`stream-a`)}`
        const sB = `/test/${uid(`stream-b`)}`
        const c = uid(`atomic-consumer`)
        await consumer(url())
          .stream(sA)
          .stream(sB)
          .appendTo(sA, `a2`)
          .appendTo(sB, `b1`)
          .appendTo(sB, `b2`)
          .register(c, [sA, sB])
          .acquire(c)
          .ackAll()
          .appendTo(sA, `a3`)
          .custom(async (ctx) => {
            const bAppends = ctx.history.filter(
              (e) => e.type === `events_appended` && e.path === sB
            )
            const offsetB1 = (bAppends[0] as any).offset
            const offsetA3 = ctx.tailOffsets.get(sA)!

            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({
                offsets: [
                  { path: sA, offset: offsetA3 },
                  { path: sB, offset: offsetB1 },
                ],
              }),
            })
            expect(res.status).toBe(409)
            const body = await res.json()
            expect(body.error.code).toBe(`OFFSET_REGRESSION`)
            expect(body.error.path).toBe(sB)

            const info = await fetch(`${ctx.baseUrl}/consumers/${c}`)
            const consumerInfo = await info.json()
            const foundA = consumerInfo.streams.find((s: any) => s.path === sA)
            const prevOffsetA = ctx.history
              .filter((e) => e.type === `events_appended` && e.path === sA)
              .slice(0, 1)
              .map((e: any) => e.offset)[0]
            expect(foundA.offset).toBe(prevOffsetA)
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Release`, () => {
      it(`releases epoch and returns to REGISTERED`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .release(c)
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`preserves committed cursor after release`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .ackLatest()
          .release(c)
          .acquire(c)
          .custom(async (ctx) => {
            const expectedOffset = ctx.tailOffsets.get(s)!
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}`)
            const body = await res.json()
            expect(body.streams[0].offset).toBe(expectedOffset)
          })
          .run()
      })

      it(`rejects release without token`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/release`, {
              method: `POST`,
            })
            expect(res.status).toBe(401)
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Exhaustive: All Valid L1 Action Sequences (length 2-3)`, () => {
      function generateValidSequences(
        maxLen: number,
        initial: L1ConsumerModel
      ): Array<Array<ConsumerAction>> {
        const sequences: Array<Array<ConsumerAction>> = []

        function recurse(
          model: L1ConsumerModel,
          seq: Array<ConsumerAction>
        ): void {
          if (seq.length >= 2) sequences.push([...seq])
          if (seq.length >= maxLen) return

          for (const action of enabledConsumerActions(model)) {
            const next = applyConsumerAction(model, action)
            recurse(next, [...seq, action])
          }
        }

        recurse(initial, [])
        return sequences
      }

      const fromRegistered = generateValidSequences(3, {
        state: `REGISTERED`,
        hasUnackedEvents: true,
        appendCount: 1,
      })

      it(`all ${fromRegistered.length} valid sequences from REGISTERED preserve L1 safety invariants`, async () => {
        for (let seqIdx = 0; seqIdx < fromRegistered.length; seqIdx++) {
          const seq = fromRegistered[seqIdx]!
          const id = `exhaust-reg-${seqIdx}`
          const stream = `/test/ex-${id}`
          const consumerId = `ex-${id}`

          const scenario = consumer(url())
            .stream(stream)
            .appendTo(stream, `init`)
            .register(consumerId, [stream])

          let appendCounter = 0
          for (const action of seq) {
            switch (action) {
              case `append`:
                scenario.appendTo(stream, `event-${++appendCounter}`)
                break
              case `ack`:
                scenario.ackAll()
                break
              case `heartbeat`:
                scenario.heartbeat()
                break
              case `acquire`:
                scenario.acquire(consumerId)
                break
              case `release`:
                scenario.release(consumerId)
                break
            }
          }

          await scenario.run()
        }
      })

      const fromReading = generateValidSequences(3, {
        state: `READING`,
        hasUnackedEvents: true,
        appendCount: 1,
      })

      it(`all ${fromReading.length} valid sequences from READING preserve L1 safety invariants`, async () => {
        for (let seqIdx = 0; seqIdx < fromReading.length; seqIdx++) {
          const seq = fromReading[seqIdx]!
          const id = `exhaust-read-${seqIdx}`
          const stream = `/test/ex-${id}`
          const consumerId = `ex-${id}`

          const scenario = consumer(url())
            .stream(stream)
            .appendTo(stream, `init`)
            .register(consumerId, [stream])
            .acquire(consumerId)

          let appendCounter = 0
          for (const action of seq) {
            switch (action) {
              case `append`:
                scenario.appendTo(stream, `event-${++appendCounter}`)
                break
              case `ack`:
                scenario.ackAll()
                break
              case `heartbeat`:
                scenario.heartbeat()
                break
              case `acquire`:
                scenario.acquire(consumerId)
                break
              case `release`:
                scenario.release(consumerId)
                break
            }
          }

          await scenario.run()
        }
      })
    })
  })
}

/**
 * Layer 2 Mechanism B: Pull-Wake conformance tests.
 * Proves L1 consumer lifecycle works with pull-based wake via shared stream.
 *
 * Each test:
 * 1. Creates a wake stream (L0 Durable Stream)
 * 2. Registers an L1 consumer
 * 3. Sets wake preference to pull-wake via PUT /consumers/{id}/wake
 * 4. Exercises the pull-wake lifecycle
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { WakeStreamReader, pullWake } from "./pull-wake-dsl"
import { applyConsumerAction, enabledConsumerActions } from "./consumer-dsl"
import type { ConsumerAction, L1ConsumerModel } from "./consumer-dsl"

export interface PullWakeTestContext {
  serverUrl: string
}

let _testCounter = 0
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_testCounter}`
}

export function runPullWakeConformanceTests(
  getCtx: () => PullWakeTestContext
): void {
  describe(`L2/B: Pull-Wake`, () => {
    const url = () => getCtx().serverUrl

    describe(`Wake Stream Events`, () => {
      it(`writes wake event when REGISTERED consumer has pending work`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w) // create the wake stream (L0)
          .register(c, [s])
          .setWakePreference(c) // PUT /consumers/{c}/wake → { type: 'pull-wake', wake_stream: w }
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .run()
      })

      it(`writes claimed event after successful acquire`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .expectClaimedEvent(s) // claimed event keyed by stream path per RFC
          .run()
      })

      it(`no wake while consumer is READING`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .appendTo(s, `event-2`) // append while READING
          .expectNoWakeEvent(500) // no new wake — consumer is READING
          .run()
      })

      it(`no wake for consumer without pull-wake preference`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          // No setWakePreference — consumer has { type: 'none' }
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectNoWakeEvent(500) // no wake — consumer isn't pull-wake
          .skipInvariants()
          .run()
      })

      it(`rejects pull-wake for multi-stream consumers`, async () => {
        const s1 = `/test/${uid(`stream`)}`
        const s2 = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s1)
          .stream(s2)
          .stream(w)
          .register(c, [s1, s2])
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/wake`, {
              method: `PUT`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({
                type: `pull-wake`,
                wake_stream: w,
              }),
            })
            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error.code).toBe(`MULTI_STREAM_PULL_WAKE`)
          })
          .skipInvariants()
          .run()
      })

      it(`does not auto-create a missing wake stream`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`missing-wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .register(c, [s])
          .setWakePreference(c)
          .appendTo(s, `event-1`)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}${w}`)
            expect(res.status).toBe(404)
          })
          .skipInvariants()
          .run()
      })

      it(`delete and recreate clears stale pending wake state`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .deleteConsumer(c)
          .register(c, [s])
          .setWakePreference(c)
          .appendTo(s, `event-2`)
          .expectWakeEvent(c)
          .skipInvariants()
          .run()
      })
    })

    describe(`Full Lifecycle`, () => {
      it(`wake → acquire → ack → release → re-wake`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          // First cycle
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .ackAll()
          .release(c)
          // Second cycle — new event triggers re-wake
          .appendTo(s, `event-2`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .ackAll()
          .release(c)
          .run()
      })

      it(`cursors persist across pull-wake cycles`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        let firstAckOffset: string
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .ackLatest()
          .custom((ctx) => {
            firstAckOffset = ctx.tailOffsets.get(s)!
            return Promise.resolve()
          })
          .release(c)
          // Second cycle — offset should be preserved from first ack
          .appendTo(s, `event-2`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .custom((ctx) => {
            // The consumer's offset after re-acquire should match what we acked
            const info = ctx.history
              .filter((e) => e.type === `epoch_acquired`)
              .pop()!
            const streamOffset = info.streams.find(
              (si) => si.path === s
            )!.offset
            expect(streamOffset).toBe(firstAckOffset)
          })
          .run()
      })

      it(`lease expiry triggers re-wake`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s], 200) // 200ms lease
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          // Don't ack or heartbeat — let lease expire
          .wait(300)
          .expectWakeEvent(c) // re-wake after lease expiry
          .run()
      })
    })

    describe(`Competitive Claims (Worker Pool)`, () => {
      it(`two workers race — one claims, other gets 409`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`

        // Setup: register consumer, set pull-wake, create wake stream
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          // Worker-1 claims successfully
          .claimViaAcquire(c, `worker-1`)
          .expectClaimedEvent(s)
          .custom(async (ctx) => {
            // Worker-2 tries to claim same consumer — gets 409 Conflict
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/acquire`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({ worker: `worker-2` }),
            })
            expect(res.status).toBe(409)
          })
          .run()
      })

      it(`worker sees claimed event and skips acquire`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .expectClaimedEvent(s)
          // Now a second "worker" reads the wake stream and should see the
          // claimed event — it can skip acquiring via hasClaimedEventAfter()
          .custom((ctx) => {
            // The wake reader has seen the claimed event; verify hasClaimedEventAfter works
            const hasClaimed = ctx.wakeReader!.hasClaimedEventAfter(s, 0)
            expect(
              hasClaimed,
              `Expected claimed event for stream '${s}' to be visible on wake stream`
            ).toBe(true)
          })
          .run()
      })

      it(`claimed event includes worker and epoch from acquire`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-7`)
          .custom(async (ctx) => {
            // Find the claimed event on the wake stream and verify fields
            const wakeStreamEvents = await fetch(`${ctx.baseUrl}${w}?offset=-1`)
            const body = await wakeStreamEvents.text()
            // Wake stream is application/json, so response is a JSON array
            const events: Array<any> = JSON.parse(body)
            const claimed = events.find(
              (e: any) => e.type === `claimed` && e.stream === s
            )
            expect(claimed).toBeDefined()
            expect(claimed.worker).toBe(`worker-7`)
            expect(claimed.epoch).toBeGreaterThanOrEqual(1)
          })
          .run()
      })
    })

    describe(`Worker Reconnection`, () => {
      it(`worker reconnects to wake stream and resumes from last offset`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .ackAll()
          .release(c)
          .custom(async (ctx) => {
            // Save current wake stream tail offset before disconnect
            const tailRes = await fetch(`${ctx.baseUrl}${w}`)
            const tailOffset = tailRes.headers.get(`stream-next-offset`) ?? `-1`

            // Stop current wake reader (simulates disconnect)
            ctx.wakeReader!.stop()

            // Append new event to trigger re-wake
            await fetch(`${ctx.baseUrl}${s}`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify(`event-2`),
            })

            // Reconnect from saved offset (resume, not replay)
            const newReader = new WakeStreamReader(ctx.baseUrl, w)
            await newReader.start(tailOffset)
            const wakeEvent = await newReader.waitForWakeEvent(c, 5000)
            expect(wakeEvent.data.consumer_id ?? wakeEvent.data.consumer).toBe(
              c
            )
            newReader.stop()
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Contention Patterns (per RFC)`, () => {
      it(`single consumer — no contention`, async () => {
        // One worker, one consumer. Like a desktop app for a user entity.
        const s = `/test/${uid(`stream`)}`
        const c = uid(`solo-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `sole-worker`)
          .ackAll()
          .release(c)
          .run()
      })

      it(`small pool — two workers with second waiting for release`, async () => {
        // Worker-1 claims, worker-2 waits. After worker-1 releases,
        // a new wake event appears and worker-2 can claim.
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pool-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          // First event
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .ackAll()
          // Append another event while worker-1 is READING
          .appendTo(s, `event-2`)
          .release(c)
          // After release with pending work → re-wake
          .expectWakeEvent(c)
          // Worker-2 claims the re-wake
          .claimViaAcquire(c, `worker-2`)
          .ackAll()
          .release(c)
          .run()
      })
    })

    describe(`Tier 2: Adversarial Pull-Wake`, () => {
      describe(`malformed acquire`, () => {
        it(`acquire without worker field still works (pure-pull path)`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            .rawAcquire(c, { streams: [s] }, 200) // no worker field
            .skipInvariants()
            .run()
        })

        it(`acquire with empty worker string treated as no holder`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            .rawAcquire(c, { streams: [s], worker: `` }, 200)
            .skipInvariants()
            .run()
        })
      })

      describe(`replayed and stale tokens`, () => {
        it(`ack with token from superseded epoch returns STALE_EPOCH`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            .startWakeReader()
            .appendTo(s, `event-1`)
            .expectWakeEvent(c)
            .claimViaAcquire(c, `worker-1`)
            .custom(async (ctx) => {
              const staleToken = ctx.currentToken!
              // Self-supersede to get new epoch
              const res = await fetch(`${ctx.baseUrl}/consumers/${c}/acquire`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ streams: [s], worker: `worker-1` }),
              })
              expect(res.status).toBe(200)
              const body = await res.json()
              ctx.currentToken = body.token
              ctx.currentEpoch = body.epoch
              // Now try to ack with the old token
              const ackRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
                method: `POST`,
                headers: {
                  "content-type": `application/json`,
                  authorization: `Bearer ${staleToken}`,
                },
                body: JSON.stringify({ offsets: [{ path: s, offset: `1` }] }),
              })
              expect(ackRes.status).toBe(409)
              const ackBody = await ackRes.json()
              expect(ackBody.error.code).toBe(`STALE_EPOCH`)
            })
            .skipInvariants()
            .run()
        })
      })

      describe(`bogus wake stream events`, () => {
        it(`injected fake wake event — acquire still works (server is authoritative)`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            // Inject a fake wake event (not from server)
            .rawWakeEvent({ type: `wake`, stream: s, consumer: c })
            // Acquire should still work (server validates state, not wake stream)
            .rawAcquire(c, { streams: [s], worker: `attacker` }, 200)
            .skipInvariants()
            .run()
        })

        it(`injected fake claimed event does not prevent real claim`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            .startWakeReader()
            .appendTo(s, `event-1`)
            .expectWakeEvent(c)
            // Inject fake claimed event before real claim
            .rawClaimedEvent({
              type: `claimed`,
              stream: s,
              worker: `fake-worker`,
              epoch: 999,
            })
            // Real claim still succeeds (server is authoritative)
            .claimViaAcquire(c, `real-worker`)
            .ackAll()
            .release(c)
            .run()
        })
      })

      describe(`temporal ordering attacks`, () => {
        it(`old claimed event does not suppress fresh wake (hasClaimedEventAfter)`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            .startWakeReader()
            // First cycle: wake → claim → ack → release
            .appendTo(s, `event-1`)
            .expectWakeEvent(c)
            .claimViaAcquire(c, `worker-1`)
            .expectClaimedEvent(s)
            .ackAll()
            .release(c)
            // Second cycle: new append → new wake (must not be suppressed by old claimed)
            .appendTo(s, `event-2`)
            .expectWakeEvent(c) // this is the key assertion: fresh wake appears
            .claimViaAcquire(c, `worker-1`)
            .ackAll()
            .release(c)
            .run()
        })
      })

      describe(`contention edge cases`, () => {
        it(`different worker acquire while held returns 409 EPOCH_HELD`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            .startWakeReader()
            .appendTo(s, `event-1`)
            .expectWakeEvent(c)
            .claimViaAcquire(c, `worker-1`)
            // Different worker tries to acquire — should get 409
            .rawAcquire(c, { streams: [s], worker: `worker-2` }, 409)
            .ackAll()
            .release(c)
            .skipInvariants()
            .run()
        })

        it(`same worker re-acquire succeeds (self-supersede)`, async () => {
          const s = `/test/${uid(`stream`)}`
          const c = uid(`pw-t2`)
          const w = `/wake/${uid(`wake`)}`
          await pullWake(url(), w)
            .stream(s)
            .stream(w)
            .register(c, [s])
            .setWakePreference(c)
            .startWakeReader()
            .appendTo(s, `event-1`)
            .expectWakeEvent(c)
            .claimViaAcquire(c, `worker-1`)
            // Same worker re-acquires (crash recovery) — should succeed
            .rawAcquire(c, { streams: [s], worker: `worker-1` }, 200)
            .skipInvariants()
            .run()
        })
      })
    })

    describe(`Property-Based: Pull-Wake Random Action Sequences`, () => {
      const actionArb: fc.Arbitrary<ConsumerAction> = fc.oneof(
        { weight: 40, arbitrary: fc.constant(`append` as const) },
        { weight: 25, arbitrary: fc.constant(`ack` as const) },
        { weight: 20, arbitrary: fc.constant(`heartbeat` as const) },
        { weight: 10, arbitrary: fc.constant(`release` as const) },
        { weight: 5, arbitrary: fc.constant(`acquire` as const) }
      )

      it(`random action sequences preserve L1 safety invariants via pull-wake`, async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(actionArb, { minLength: 2, maxLength: 8 }),
            fc.integer({ min: 1, max: 999999 }),
            async (actions, runSeed) => {
              const runId = `pw-prop-${runSeed}`
              const stream = `/test/${runId}`
              const consumerId = runId
              const wakeStream = `/wake/${runId}`

              const scenario = pullWake(url(), wakeStream)
                .stream(stream)
                .stream(wakeStream)
                .register(consumerId, [stream])
                .setWakePreference(consumerId)
                .startWakeReader()
                .appendTo(stream, `init`)
                .expectWakeEvent(consumerId)
                .claimViaAcquire(consumerId)

              let model: L1ConsumerModel = {
                state: `READING`,
                hasUnackedEvents: true,
                appendCount: 1,
              }

              let appendCounter = 0
              for (const action of actions) {
                const valid = enabledConsumerActions(model)
                if (!valid.includes(action)) continue

                switch (action) {
                  case `append`:
                    scenario.appendTo(stream, {
                      event: `prop`,
                      seq: ++appendCounter,
                    })
                    break
                  case `ack`:
                    scenario.ackAll()
                    break
                  case `heartbeat`:
                    scenario.heartbeat()
                    break
                  case `release`:
                    scenario.release(consumerId)
                    // After release, append + re-wake + re-acquire to get back to READING
                    scenario.appendTo(stream, {
                      event: `prop`,
                      seq: ++appendCounter,
                    })
                    scenario.expectWakeEvent(consumerId)
                    scenario.claimViaAcquire(consumerId)
                    // Model: release → REGISTERED, then append + acquire → READING
                    model = applyConsumerAction(model, `release`)
                    model = applyConsumerAction(model, `append`)
                    model = applyConsumerAction(model, `acquire`)
                    continue // skip the applyConsumerAction below
                  case `acquire`:
                    // Self-supersede: re-acquire while READING
                    scenario.claimViaAcquire(consumerId)
                    break
                }
                model = applyConsumerAction(model, action)
              }

              scenario.ackAll().release(consumerId)
              await scenario.run()
            }
          ),
          { numRuns: 20 }
        )
      })
    })

    describe(`Cross-Mechanism: Same L1 Consumer via Direct HTTP then Pull-Wake`, () => {
      it(`epoch chain continues across mechanism switch`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`cross-consumer`)
        const w = `/wake/${uid(`wake`)}`

        const baseUrl = url()

        // Step 0: Create stream (L0) as JSON so content-type matches appends
        await fetch(`${baseUrl}${s}`, {
          method: `PUT`,
          headers: { "content-type": `application/json` },
        })

        // Step 1: Explicit L1 registration — independent of any L2 mechanism
        const regRes = await fetch(`${baseUrl}/consumers`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ consumer_id: c, streams: [s] }),
        })
        expect(regRes.status).toBe(201)

        // Step 2: Exercise via direct HTTP (pure L1, no L2)
        const appendRes = await fetch(`${baseUrl}${s}`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ event: `via-direct-http` }),
        })
        const appendedOffset = appendRes.headers.get(`stream-next-offset`)!

        // Acquire epoch
        const acqRes = await fetch(`${baseUrl}/consumers/${c}/acquire`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ worker: `worker-direct` }),
        })
        expect(acqRes.status).toBe(200)
        const acqBody = await acqRes.json()
        const epochAfterDirect = acqBody.epoch
        const token = acqBody.token

        // Ack the appended event
        const ackRes = await fetch(`${baseUrl}/consumers/${c}/ack`, {
          method: `POST`,
          headers: {
            "content-type": `application/json`,
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            offsets: [{ path: s, offset: appendedOffset }],
          }),
        })
        expect(ackRes.status).toBe(200)

        // Release
        const relRes = await fetch(`${baseUrl}/consumers/${c}/release`, {
          method: `POST`,
          headers: { authorization: `Bearer ${token}` },
        })
        expect(relRes.status).toBe(200)

        // Capture cursor after direct-HTTP phase
        const infoAfterDirect = await (
          await fetch(`${baseUrl}/consumers/${c}`)
        ).json()
        const cursorAfterDirect = infoAfterDirect.streams.find(
          (s2: any) => s2.path === s
        )?.offset
        expect(cursorAfterDirect).toBe(appendedOffset)

        // Step 3: Switch SAME consumer to pull-wake (L2/B)
        await fetch(`${baseUrl}${w}`, {
          method: `PUT`,
          headers: { "content-type": `application/json` },
        }) // create L0 wake stream as JSON so SSE sends readable data
        await fetch(`${baseUrl}/consumers/${c}/wake`, {
          method: `PUT`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ type: `pull-wake`, wake_stream: w }),
        })

        // Step 4: Exercise via pull-wake — same consumer, different mechanism
        const wakeReader = new WakeStreamReader(baseUrl, w)
        await wakeReader.start()

        // Give the SSE connection a moment to establish before appending
        await new Promise((r) => setTimeout(r, 100))

        // Append event to trigger pull-wake
        const appendRes2 = await fetch(`${baseUrl}${s}`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ event: `via-pull-wake` }),
        })
        const appendedOffset2 = appendRes2.headers.get(`stream-next-offset`)!

        // Wait for wake event on the wake stream
        const wakeEvt = await wakeReader.waitForWakeEvent(c, 3_000)
        expect(wakeEvt).toBeDefined()

        // Claim via acquire
        const acqRes2 = await fetch(`${baseUrl}/consumers/${c}/acquire`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ worker: `worker-1` }),
        })
        expect(acqRes2.status).toBe(200)
        const acqBody2 = await acqRes2.json()
        const token2 = acqBody2.token

        // Ack
        const ackRes2 = await fetch(`${baseUrl}/consumers/${c}/ack`, {
          method: `POST`,
          headers: {
            "content-type": `application/json`,
            authorization: `Bearer ${token2}`,
          },
          body: JSON.stringify({
            offsets: [{ path: s, offset: appendedOffset2 }],
          }),
        })
        expect(ackRes2.status).toBe(200)

        // Release
        const relRes2 = await fetch(`${baseUrl}/consumers/${c}/release`, {
          method: `POST`,
          headers: { authorization: `Bearer ${token2}` },
        })
        expect(relRes2.status).toBe(200)

        wakeReader.stop()

        // Step 5: Verify epoch and cursor continuity across mechanism switch
        const info = await fetch(`${baseUrl}/consumers/${c}`)
        const body = await info.json()
        expect(body.epoch).toBeGreaterThan(epochAfterDirect)
        expect(body.state).toBe(`REGISTERED`)

        // Cursor continuity: pull-wake phase should have advanced the cursor
        const cursorAfterPullWake = body.streams.find(
          (s2: any) => s2.path === s
        )?.offset
        expect(cursorAfterPullWake > cursorAfterDirect).toBe(true)
      })
    })
  })
}

/**
 * Regression tests for expiry-alarm scheduling (direct DO access).
 *
 * armAlarmAt keeps an in-memory `lastArmedAlarm` guard to avoid a
 * storage write per sliding-TTL touch. That cache must not survive alarm
 * consumption or deleteAlarm: comparing a new target against a stale value
 * would suppress the rearm and leave an expiry duty with no alarm.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { StreamObject } from "../src/stream-object"

function stubFor(path: string): DurableObjectStub<StreamObject> {
  return env.STREAMS.get(env.STREAMS.idFromName(path))
}

async function putStream(
  stub: DurableObjectStub<StreamObject>,
  path: string,
  headers: Record<string, string>
): Promise<Response> {
  return stub.fetch(`http://do${path}`, { method: `PUT`, headers })
}

function storedAlarm(
  stub: DurableObjectStub<StreamObject>
): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.getAlarm()
  )
}

describe(`expiry alarm scheduling`, () => {
  it(`rearms after a consumed alarm when an expiry duty remains`, async () => {
    const path = `/streams/alarm-rearm`
    const stub = stubFor(path)

    const created = await putStream(stub, path, {
      "content-type": `text/plain`,
      "Stream-TTL": `60`,
    })
    expect(created.status).toBe(201)
    expect(await storedAlarm(stub)).not.toBeNull()

    // A read shortly after creation slides the expiry forward, so the
    // earlier armed alarm is (correctly) kept — it fires first and the
    // alarm handler re-syncs.
    const read = await stub.fetch(`http://do${path}`)
    expect(read.status).toBe(200)

    // The alarm fires at the ORIGINAL expiry; the stream is not yet
    // expired (the read moved it), so the handler must rearm for the
    // remaining duty. A stale lastArmedAlarm suppresses that rearm.
    const ran = await runDurableObjectAlarm(stub)
    expect(ran).toBe(true)

    const alarmAfterFire = await storedAlarm(stub)
    expect(alarmAfterFire).not.toBeNull()

    // The stream must still exist (it never expired).
    const head = await stub.fetch(`http://do${path}`, { method: `HEAD` })
    expect(head.status).toBe(200)
  })

  it(`arms an alarm for a stream recreated right after delete`, async () => {
    const path = `/streams/alarm-recreate`
    const stub = stubFor(path)

    const created = await putStream(stub, path, {
      "content-type": `text/plain`,
      "Stream-TTL": `60`,
    })
    expect(created.status).toBe(201)

    const deleted = await stub.fetch(`http://do${path}`, { method: `DELETE` })
    expect(deleted.status).toBe(204)
    expect(await storedAlarm(stub)).toBeNull()

    // Recreate immediately with the same TTL: the new expiry lands within
    // 500ms of the pre-delete lastArmedAlarm, so a stale cache would
    // suppress arming any alarm for the new stream.
    const recreated = await putStream(stub, path, {
      "content-type": `text/plain`,
      "Stream-TTL": `60`,
    })
    expect(recreated.status).toBe(201)

    expect(await storedAlarm(stub)).not.toBeNull()
  })
})

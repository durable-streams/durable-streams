/**
 * Reproduction tests for YjsProvider awareness delivery bug.
 *
 * Issue: YjsProvider's internal awareness subscription does not apply live
 * awareness updates into the receiving Awareness instance, even though:
 * - Raw HTTP long-poll receives the bytes
 * - DurableStream client subscribeBytes receives the bytes
 * - Manual applyAwarenessUpdate() correctly updates awareness state
 *
 * Root cause hypothesis: The awareness subscription in subscribeAwareness()
 * does not retain the unsubscribe callback from response.subscribeBytes(),
 * unlike the document updates subscription which stores it in
 * this.updatesSubscription. This may allow the subscription to be dropped.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness"
import * as decoding from "lib0/decoding"
import * as Y from "yjs"
import { YjsServer } from "../src/server"
import { YjsProvider } from "../src"

const SHORT_TIMEOUT_MS = 2_000
const DEFAULT_TIMEOUT_MS = 5_000

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  intervalMs: number = 50
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timeout waiting for ${label}`)
}

async function waitForSync(
  provider: YjsProvider,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<void> {
  await waitForCondition(() => provider.synced, `provider sync`, timeoutMs)
}

async function createProviderWithAwareness(
  yjsServer: YjsServer,
  options?: Partial<{
    doc: Y.Doc
    liveMode: `sse` | `long-poll`
    docId: string
    awareness: Awareness
    serviceName: string
  }>
) {
  const {
    doc = new Y.Doc(),
    liveMode = `long-poll`,
    docId = `document`,
    awareness = new Awareness(doc),
    serviceName = `test-service-name`,
  } = options ?? {}

  const provider = new YjsProvider({
    doc,
    docId,
    liveMode,
    connect: false,
    baseUrl: `${yjsServer.url}/v1/yjs/${serviceName}`,
    awareness,
  })

  await provider.connect()
  await waitForSync(provider)

  return { provider, awareness }
}

function awarenessUrl(
  baseUrl: string,
  serviceName: string,
  docId: string
): string {
  return `${baseUrl}/v1/yjs/${serviceName}/docs/${docId}?awareness=default`
}

async function readAwarenessLongPoll(
  url: string,
  offset: string
): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await fetch(
    `${url}&offset=${encodeURIComponent(offset)}&live=long-poll`
  )
  return {
    status: response.status,
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

function applyFramedAwarenessUpdates(
  target: Awareness,
  bytes: Uint8Array
): void {
  const decoder = decoding.createDecoder(bytes)
  while (decoding.hasContent(decoder)) {
    applyAwarenessUpdate(target, decoding.readVarUint8Array(decoder), `test`)
  }
}

describe(`YjsProvider awareness delivery repro`, () => {
  let dsServer: DurableStreamTestServer
  let yjsServer: YjsServer

  beforeAll(async () => {
    dsServer = new DurableStreamTestServer({ port: 0 })
    await dsServer.start()

    yjsServer = new YjsServer({
      port: 0,
      dsServerUrl: dsServer.url,
    })
    await yjsServer.start()
  })

  afterAll(async () => {
    yjsServer.stop().catch(() => {})
    dsServer.stop().catch(() => {})
    await new Promise((r) => setTimeout(r, 200))
  }, 5000)

  it(`raw long-poll sees the live awareness update`, async () => {
    const docId = crypto.randomUUID()
    const serviceName = `root-cause-raw-long-poll`

    const { awareness: sender } = await createProviderWithAwareness(yjsServer, {
      docId,
      serviceName,
    })

    const url = awarenessUrl(yjsServer.url, serviceName, docId)

    const pendingRead = readAwarenessLongPoll(url, `now`)
    sender.setLocalStateField(`user`, { name: `Alice` })

    const rawResult = await pendingRead
    expect(rawResult.status).toBe(200)
    expect(rawResult.bytes.length).toBeGreaterThan(0)
  })

  it(`durable stream client subscribeBytes receives live awareness bytes`, async () => {
    const docId = crypto.randomUUID()
    const serviceName = `root-cause-ds-client`

    const { awareness: sender } = await createProviderWithAwareness(yjsServer, {
      docId,
      serviceName,
    })

    const stream = new DurableStream({
      url: awarenessUrl(yjsServer.url, serviceName, docId),
      contentType: `application/octet-stream`,
    })

    const responsePromise = stream.stream({ offset: `now`, live: `long-poll` })
    await new Promise((resolve) => setTimeout(resolve, 100))

    sender.setLocalStateField(`user`, { name: `Alice` })

    const response = await responsePromise
    const chunks: Array<Uint8Array> = []
    response.subscribeBytes(async (chunk) => {
      chunks.push(chunk.data)
    })

    await waitForCondition(
      () => chunks.some((chunk) => chunk.length > 0),
      `durable stream client to receive live awareness bytes`,
      SHORT_TIMEOUT_MS
    )
  })

  it(`manual apply of live long-poll bytes updates a standalone Awareness instance`, async () => {
    const docId = crypto.randomUUID()
    const serviceName = `root-cause-live-manual-apply`

    const { awareness: sender } = await createProviderWithAwareness(yjsServer, {
      docId,
      serviceName,
    })

    // Use a standalone Awareness (not attached to any provider) so we can
    // verify that manual application works in isolation.
    const standaloneDoc = new Y.Doc()
    const standalone = new Awareness(standaloneDoc)

    const url = awarenessUrl(yjsServer.url, serviceName, docId)
    const pendingRead = readAwarenessLongPoll(url, `now`)

    sender.setLocalStateField(`user`, { name: `Alice` })

    const rawResult = await pendingRead
    expect(rawResult.status).toBe(200)
    expect(standalone.getStates().get(sender.clientID)).toBeUndefined()

    applyFramedAwarenessUpdates(standalone, rawResult.bytes)
    expect(standalone.getStates().get(sender.clientID)?.user).toEqual({
      name: `Alice`,
    })
  })

  it(`provider awareness subscription applies live updates from another provider`, async () => {
    const docId = crypto.randomUUID()
    const serviceName = `root-cause-provider-live`

    const { awareness: sender } = await createProviderWithAwareness(yjsServer, {
      docId,
      serviceName,
    })
    const { awareness: receiver } = await createProviderWithAwareness(
      yjsServer,
      { docId, serviceName }
    )

    sender.setLocalStateField(`user`, { name: `Alice` })

    await waitForCondition(
      () => receiver.getStates().get(sender.clientID)?.user?.name === `Alice`,
      `provider receiver to apply live awareness update`,
      SHORT_TIMEOUT_MS
    )
  })

  it(`manual fetch and apply hydrates the same awareness bytes successfully`, async () => {
    const docId = crypto.randomUUID()
    const serviceName = `root-cause-manual-apply`

    const { awareness: sender } = await createProviderWithAwareness(yjsServer, {
      docId,
      serviceName,
    })
    const { awareness: receiver } = await createProviderWithAwareness(
      yjsServer,
      { docId, serviceName }
    )

    const url = awarenessUrl(yjsServer.url, serviceName, docId)
    sender.setLocalStateField(`user`, { name: `Alice` })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const response = await fetch(`${url}&offset=-1`)
    expect(response.status).toBe(200)

    applyFramedAwarenessUpdates(
      receiver,
      new Uint8Array(await response.arrayBuffer())
    )
    expect(receiver.getStates().get(sender.clientID)?.user).toEqual({
      name: `Alice`,
    })
  })
})

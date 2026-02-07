/**
 * Webhook Agent Runner — a self-contained demo of the Durable Streams
 * webhook subscription system.
 *
 * Starts a server, registers a wildcard subscription, creates task streams,
 * and shows agents waking up, processing events, and going idle — all with
 * real-time console output across multiple phases.
 *
 * Run: pnpm start
 */

import { createServer } from "node:http"
import { createHmac, timingSafeEqual } from "node:crypto"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { IncomingMessage, ServerResponse } from "node:http"

// ─── Logging ─────────────────────────────────────────────────────────────────

const C = {
  reset: `\x1b[0m`,
  dim: `\x1b[2m`,
  bold: `\x1b[1m`,
  green: `\x1b[32m`,
  cyan: `\x1b[36m`,
  yellow: `\x1b[33m`,
  magenta: `\x1b[35m`,
  blue: `\x1b[34m`,
  red: `\x1b[31m`,
  white: `\x1b[37m`,
}

function log(tag: string, color: string, msg: string) {
  const padded = tag.padEnd(7)
  console.log(`  ${color}[${padded}]${C.reset}  ${msg}`)
}

function phase(title: string) {
  console.log()
  console.log(
    `  ${C.dim}── ${title} ${`─`.repeat(Math.max(0, 52 - title.length))}${C.reset}`
  )
  console.log()
}

// ─── HMAC signature verification ─────────────────────────────────────────────

function verifySignature(
  body: string,
  header: string,
  secret: string
): boolean {
  const match = header.match(/t=(\d+),sha256=([a-f0-9]+)/)
  if (!match) return false
  const [, timestamp, signature] = match
  const payload = `${timestamp}.${body}`
  const expected = createHmac(`sha256`, secret).update(payload).digest(`hex`)
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface WebhookNotification {
  consumer_id: string
  epoch: number
  wake_id: string
  primary_stream: string
  streams: Array<{ path: string; offset: string }>
  triggered_by: Array<string>
  callback: string
  token: string
}

// ─── Coordination ────────────────────────────────────────────────────────────

const pendingWakes = new Map<string, { resolve: () => void }>()

function waitForStream(path: string): Promise<void> {
  let resolve: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  pendingWakes.set(path, { resolve: resolve! })
  return promise
}

function markStreamDone(path: string) {
  const entry = pendingWakes.get(path)
  if (entry) {
    pendingWakes.delete(path)
    entry.resolve()
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log()
  console.log(`  ${C.bold}Webhook Agent Runner${C.reset}`)
  console.log(`  ${C.dim}════════════════════${C.reset}`)

  // ── Phase 1: Setup ────────────────────────────────────────────────────────

  phase(`Phase 1: Setup`)

  const server = new DurableStreamTestServer({
    port: 0,
    longPollTimeout: 500,
    webhooks: true,
  })
  const serverUrl = await server.start()
  log(`server`, C.green, `Started on ${C.bold}${serverUrl}${C.reset}`)

  await sleep(800)

  let webhookSecret = ``
  const receiver = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Array<Buffer> = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks).toString()

      const sigHeader = req.headers[`webhook-signature`] as string | undefined
      if (!sigHeader || !verifySignature(body, sigHeader, webhookSecret)) {
        log(`recv`, C.red, `Signature verification FAILED`)
        res.writeHead(401)
        res.end()
        return
      }

      log(`recv`, C.cyan, `${C.dim}Signature verified ✓${C.reset}`)

      const notification: WebhookNotification = JSON.parse(body)
      const stream = notification.primary_stream
      const shortName = stream.split(`/`).pop()!

      log(
        `wake`,
        C.yellow,
        `${C.dim}←${C.reset} ${C.bold}${shortName}${C.reset}  ` +
          `epoch=${notification.epoch}  wake_id=${notification.wake_id.slice(0, 10)}…`
      )

      res.writeHead(200, { "content-type": `application/json` })
      res.end(JSON.stringify({ ok: true }))

      // Small delay so the coordinator log lines settle before agent starts
      await sleep(400)

      processWake(serverUrl, notification, shortName).catch((err) => {
        log(`agent`, C.red, `${shortName}  Error: ${err.message}`)
      })
    }
  )

  const receiverUrl = await new Promise<string>((resolve) => {
    receiver.listen(0, `127.0.0.1`, () => {
      const addr = receiver.address()
      if (addr && typeof addr !== `string`) {
        resolve(`http://127.0.0.1:${addr.port}`)
      }
    })
  })
  log(`recv`, C.cyan, `Webhook receiver on ${C.bold}${receiverUrl}${C.reset}`)

  await sleep(800)

  const subRes = await fetch(
    `${serverUrl}/agents/*?subscription=agent-runner`,
    {
      method: `PUT`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({
        webhook: `${receiverUrl}/webhook`,
        description: `Demo agent runner`,
      }),
    }
  )
  const subData = (await subRes.json()) as { webhook_secret?: string }
  webhookSecret = subData.webhook_secret ?? ``
  log(
    `sub`,
    C.magenta,
    `Created ${C.bold}"agent-runner"${C.reset} watching /agents/*`
  )
  log(
    `sub`,
    C.magenta,
    `${C.dim}Secret: ${webhookSecret.slice(0, 16)}…${C.reset}`
  )

  // ── Agent worker ──────────────────────────────────────────────────────────

  async function processWake(
    baseUrl: string,
    notification: WebhookNotification,
    shortName: string
  ) {
    const { callback, token, epoch, wake_id } = notification
    const stream = notification.primary_stream
    const pad = shortName.padEnd(14)

    // The token from the webhook notification is valid for 60 minutes,
    // so we reuse it for all callbacks in this wake cycle.

    // Step 1: Claim the wake
    log(`agent`, C.blue, `${pad} ${C.dim}Step 1:${C.reset} Claiming wake…`)
    await sleep(300)
    const claimRes = await fetch(callback, {
      method: `POST`,
      headers: {
        "content-type": `application/json`,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ epoch, wake_id }),
    })
    const claimData = (await claimRes.json()) as {
      ok: boolean
      token?: string
      streams?: Array<{ path: string; offset: string }>
      error?: { code: string }
    }

    if (!claimData.ok) {
      if (claimData.error?.code === `ALREADY_CLAIMED`) {
        log(`agent`, C.dim, `${pad} Already claimed (stale retry), skipping`)
        return
      }
      log(`agent`, C.red, `${pad} Claim failed: ${claimData.error?.code}`)
      return
    }
    log(`agent`, C.blue, `${pad} ${C.dim}Claimed! State → LIVE${C.reset}`)
    await sleep(500)

    // Step 2: Read events from the stream
    log(
      `agent`,
      C.blue,
      `${pad} ${C.dim}Step 2:${C.reset} Reading stream ${C.dim}GET ${stream}${C.reset}`
    )
    const streamOffset =
      claimData.streams?.find((s) => s.path === stream)?.offset ?? `-1`
    const readRes = await fetch(`${baseUrl}${stream}?offset=${streamOffset}`)
    const events = (await readRes.json()) as Array<{
      type: string
      task?: string
      message?: string
    }>
    const nextOffset = readRes.headers.get(`stream-next-offset`) ?? streamOffset
    log(
      `agent`,
      C.blue,
      `${pad} ${C.dim}Got ${events.length} event(s), next offset=${nextOffset}${C.reset}`
    )
    await sleep(500)

    // Find the latest actionable event
    const latestTask = [...events]
      .reverse()
      .find((e) => e.type === `assigned` || e.type === `follow-up`)

    if (!latestTask) {
      log(`agent`, C.dim, `${pad} No actionable events, signaling done`)
      await fetch(callback, {
        method: `POST`,
        headers: {
          "content-type": `application/json`,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ epoch, done: true }),
      })
      log(`agent`, C.blue, `${pad} ${C.dim}→ IDLE${C.reset}`)
      markStreamDone(stream)
      return
    }

    const taskMsg = latestTask.task ?? latestTask.message ?? `(unknown)`
    const isFollowUp = latestTask.type === `follow-up`

    if (isFollowUp) {
      log(
        `agent`,
        C.blue,
        `${pad} ${C.bold}Re-woken!${C.reset} Task: "${C.bold}${taskMsg}${C.reset}"`
      )
    } else {
      log(
        `agent`,
        C.blue,
        `${pad} ${C.dim}Step 3:${C.reset} Processing: "${C.bold}${taskMsg}${C.reset}"`
      )
    }

    // Step 3: Simulate work
    await sleep(600)
    log(`agent`, C.blue, `${pad} ${C.dim}Working…${C.reset}`)
    await sleep(1500 + Math.random() * 500)
    log(`agent`, C.blue, `${pad} ${C.dim}Work complete.${C.reset}`)
    await sleep(400)

    // Step 4: Ack progress
    log(
      `agent`,
      C.blue,
      `${pad} ${C.dim}Step 4:${C.reset} Ack offset=${nextOffset}`
    )
    await fetch(callback, {
      method: `POST`,
      headers: {
        "content-type": `application/json`,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        epoch,
        acks: [{ path: stream, offset: nextOffset }],
      }),
    })
    log(`agent`, C.blue, `${pad} ${C.dim}Acked.${C.reset}`)
    await sleep(400)

    // Step 5: Signal done
    log(`agent`, C.blue, `${pad} ${C.dim}Step 5:${C.reset} Signaling done`)
    await fetch(callback, {
      method: `POST`,
      headers: {
        "content-type": `application/json`,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ epoch, done: true }),
    })
    log(
      `agent`,
      C.blue,
      `${pad} ${C.green}Done${C.reset} ${C.dim}→ IDLE${C.reset}`
    )

    markStreamDone(stream)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function createAndAssign(path: string, task: string) {
    const shortName = path.split(`/`).pop()!
    log(`coord`, C.white, `Creating stream: ${C.bold}${path}${C.reset}`)
    await fetch(`${serverUrl}${path}`, {
      method: `PUT`,
      headers: { "content-type": `application/json` },
      body: `[]`,
    })
    await sleep(400)
    await fetch(`${serverUrl}${path}`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ type: `assigned`, task }),
    })
    log(`coord`, C.white, `Assigned ${C.bold}${shortName}${C.reset}: "${task}"`)
  }

  async function sendFollowUp(path: string, task: string) {
    const shortName = path.split(`/`).pop()!
    log(
      `coord`,
      C.white,
      `Follow-up on ${C.bold}${shortName}${C.reset}: "${task}"`
    )
    await fetch(`${serverUrl}${path}`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ type: `follow-up`, task }),
    })
  }

  // ── Phase 2: Single task ──────────────────────────────────────────────────

  phase(`Phase 2: Single task — one agent wakes, works, idles`)

  await createAndAssign(`/agents/task-alpha`, `Summarize quantum computing`)
  const alphaP1 = waitForStream(`/agents/task-alpha`)
  await alphaP1

  await sleep(1200)

  // ── Phase 3: Parallel tasks ───────────────────────────────────────────────

  phase(`Phase 3: Two tasks at once — parallel agent execution`)

  await createAndAssign(`/agents/task-beta`, `Write a haiku about streams`)
  const betaP1 = waitForStream(`/agents/task-beta`)

  await sleep(1000)

  await createAndAssign(
    `/agents/task-gamma`,
    `Translate "hello world" into 3 languages`
  )
  const gammaP1 = waitForStream(`/agents/task-gamma`)

  await Promise.all([betaP1, gammaP1])

  await sleep(1200)

  // ── Phase 4: Follow-ups (re-wakes) ────────────────────────────────────────

  phase(`Phase 4: Follow-ups — re-waking idle agents (epoch increments)`)

  await sendFollowUp(`/agents/task-alpha`, `Now explain it to a 5-year-old`)
  const alphaP2 = waitForStream(`/agents/task-alpha`)
  await alphaP2

  await sleep(1200)

  await sendFollowUp(`/agents/task-beta`, `Now rewrite it about robots`)
  const betaP2 = waitForStream(`/agents/task-beta`)
  await betaP2

  await sleep(1200)

  // ── Phase 5: Chain — multiple re-wakes on same stream ─────────────────────

  phase(`Phase 5: Chain — third wake on task-alpha (epoch=3)`)

  await sendFollowUp(`/agents/task-alpha`, `Add a pizza analogy`)
  const alphaP3 = waitForStream(`/agents/task-alpha`)
  await alphaP3

  await sleep(1200)

  // ── Phase 6: Late arrival ─────────────────────────────────────────────────

  phase(`Phase 6: New task for a stream that already exists`)

  await sendFollowUp(`/agents/task-gamma`, `Now do French, German, and Swahili`)
  const gammaP2 = waitForStream(`/agents/task-gamma`)
  await gammaP2

  // ── Shutdown ──────────────────────────────────────────────────────────────

  await sleep(600)
  console.log()
  console.log(
    `  ${C.dim}────────────────────────────────────────────────────────────${C.reset}`
  )
  console.log()
  console.log(
    `  ${C.green}${C.bold}All tasks complete.${C.reset} Shutting down.`
  )
  console.log()

  receiver.close()
  await server.stop()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

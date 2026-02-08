/**
 * Agent processing logic using the modular adapter pattern.
 *
 * When a webhook notification arrives, the agent:
 *   1. Claims the wake + reads initial events in parallel
 *   2. Creates an AgentAdapter (pi-agent-core by default) and processes the task
 *   3. Opens a live subscription for follow-ups (60s idle timeout)
 *      - If adapter is running → steer (interrupt current execution)
 *      - If adapter is idle → processMessage (new turn)
 *   4. Acks through tail offset and signals done
 */

import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api"
import { DurableStream } from "@durable-streams/client"
import { getDSServerUrl } from "./setup"
import { createPiAgentAdapter } from "./adapters/pi-agent"

const tracer = trace.getTracer(`durable-streams.agent-worker`)

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

type StreamEvent = {
  type: string
  task?: string
  value?: { type: string; task?: string }
}

const IDLE_TIMEOUT = 60_000
const HEARTBEAT_INTERVAL = 30_000

function findActionable(
  events: ReadonlyArray<StreamEvent>
): StreamEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const eventType = e.type === `event` ? e.value?.type : e.type
    if (eventType === `agent_done` || eventType === `agent_error`) {
      return undefined
    }
    if (eventType === `assigned` || eventType === `follow_up`) {
      return e
    }
  }
  return undefined
}

function extractTaskMsg(event: StreamEvent): string | undefined {
  return event.type === `event` ? event.value?.task : event.task
}

export async function processWake(
  notification: WebhookNotification,
  traceparent?: string
) {
  const { callback, token, epoch, wake_id } = notification
  const streamPath = notification.primary_stream
  const shortName = streamPath.split(`/`).pop()!
  const baseUrl = getDSServerUrl()

  const parentCtx = traceparent
    ? propagation.extract(context.active(), { traceparent })
    : context.active()

  const rootSpan = tracer.startSpan(
    `agent.process_wake`,
    {
      attributes: {
        "agent.task": shortName,
        "agent.stream": streamPath,
        "agent.epoch": epoch,
        "agent.wake_id": wake_id,
        "agent.consumer_id": notification.consumer_id,
      },
    },
    parentCtx
  )
  const rootCtx = trace.setSpan(parentCtx, rootSpan)
  let heartbeat: ReturnType<typeof setInterval> | null = null

  try {
    const streamOffset =
      notification.streams.find((s) => s.path === streamPath)?.offset ?? `-1`

    const handle = new DurableStream({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    console.log(
      `[agent] ${shortName} — claiming wake + reading stream in parallel (epoch=${epoch})`
    )

    const claimSpan = tracer.startSpan(`agent.claim`, {}, rootCtx)
    const readSpan = tracer.startSpan(
      `agent.read_stream`,
      { attributes: { "agent.offset": streamOffset } },
      rootCtx
    )

    const claimPromise = fetch(callback, {
      method: `POST`,
      headers: {
        "content-type": `application/json`,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ epoch, wake_id }),
    }).then(async (res) => {
      const data = (await res.json()) as {
        ok: boolean
        token?: string
        streams?: Array<{ path: string; offset: string }>
        error?: { code: string }
      }
      claimSpan.end()
      return data
    })

    const readPromise = handle
      .stream<StreamEvent>({ offset: streamOffset, live: false })
      .then(async (catchUpRes) => {
        const items = await catchUpRes.json()
        readSpan.setAttribute(`agent.event_count`, items.length)
        readSpan.end()
        return { items, catchUpRes }
      })

    const [claimData, { items: events, catchUpRes: catchUp }] =
      await Promise.all([claimPromise, readPromise])

    if (!claimData.ok) {
      if (claimData.error?.code === `ALREADY_CLAIMED`) {
        console.log(`[agent] ${shortName} — stale retry, skipping`)
        rootSpan.addEvent(`stale_retry`)
        return
      }
      console.log(
        `[agent] ${shortName} — claim failed: ${claimData.error?.code}`
      )
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: `claim_failed`,
      })
      return
    }
    console.log(
      `[agent] ${shortName} — claimed → LIVE, got ${events.length} event(s)`
    )

    // Use the refreshed token from claim response if available
    let activeToken = claimData.token ?? token

    // Heartbeat keeps the server's liveness timer alive during long-running work
    heartbeat = setInterval(() => {
      fetch(callback, {
        method: `POST`,
        headers: {
          "content-type": `application/json`,
          authorization: `Bearer ${activeToken}`,
        },
        body: JSON.stringify({ epoch }),
      })
        .then(async (res) => {
          const data = (await res.json()) as { ok: boolean; token?: string }
          if (data.token) activeToken = data.token
        })
        .catch((err) => {
          console.error(`[agent] ${shortName} — heartbeat error:`, err)
        })
    }, HEARTBEAT_INTERVAL)

    const actionable = findActionable(events)
    if (!actionable) {
      console.log(`[agent] ${shortName} — no actionable events, acking + done`)
      rootSpan.addEvent(`no_actionable_events`)
      clearInterval(heartbeat)
      await fetch(callback, {
        method: `POST`,
        headers: {
          "content-type": `application/json`,
          authorization: `Bearer ${activeToken}`,
        },
        body: JSON.stringify({
          epoch,
          acks: [{ path: streamPath, offset: catchUp.offset }],
          done: true,
        }),
      })
      return
    }

    // Create the agent adapter for this wake cycle
    const adapter = createPiAgentAdapter({
      handle,
      streamPath,
      epoch,
      parentCtx: rootCtx,
    })

    // Process initial task
    const taskMsg = extractTaskMsg(actionable) ?? `unknown`
    console.log(`[agent] ${shortName} — processing: "${taskMsg}"`)

    const workSpan = tracer.startSpan(
      `agent.llm_work`,
      { attributes: { "agent.task_msg": taskMsg } },
      rootCtx
    )
    await adapter.processMessage(taskMsg)
    workSpan.end()

    // Open live subscription for follow-ups
    const idleController = new AbortController()
    let idleTimer: ReturnType<typeof setTimeout> = setTimeout(
      () => idleController.abort(),
      IDLE_TIMEOUT
    )

    const listenSpan = tracer.startSpan(
      `agent.listen_followups`,
      { attributes: { "agent.idle_timeout_ms": IDLE_TIMEOUT } },
      rootCtx
    )

    console.log(
      `[agent] ${shortName} — listening for follow-ups (${IDLE_TIMEOUT / 1000}s timeout)`
    )

    let liveRes: Awaited<ReturnType<typeof handle.stream<StreamEvent>>> | null =
      null
    let followUpCount = 0
    try {
      liveRes = await handle.stream<StreamEvent>({
        offset: catchUp.offset,
        live: true,
        signal: idleController.signal,
      })

      await new Promise<void>((resolve) => {
        const unsub = liveRes!.subscribeJson(async (batch) => {
          const followUp = findActionable(batch.items)
          if (!followUp) return

          clearTimeout(idleTimer)
          const msg = extractTaskMsg(followUp) ?? `unknown`
          console.log(`[agent] ${shortName} — follow-up: "${msg}"`)
          listenSpan.addEvent(`follow_up_received`, { "agent.task_msg": msg })

          if (adapter.isRunning()) {
            console.log(
              `[agent] ${shortName} — steering (agent is mid-execution)`
            )
            adapter.steer(msg)
          } else {
            const fuSpan = tracer.startSpan(
              `agent.llm_work`,
              { attributes: { "agent.task_msg": msg } },
              rootCtx
            )
            await adapter.processMessage(msg)
            fuSpan.end()
          }

          followUpCount++
          idleTimer = setTimeout(() => idleController.abort(), IDLE_TIMEOUT)
        })

        idleController.signal.addEventListener(`abort`, () => {
          unsub()
          resolve()
        })
      })
    } catch {
      // AbortError expected when idle timeout fires
    }

    clearTimeout(idleTimer)
    clearInterval(heartbeat)
    adapter.dispose()
    listenSpan.addEvent(`idle_timeout`)
    listenSpan.setAttribute(`agent.follow_up_count`, followUpCount)
    listenSpan.end()

    // Ack through tail and signal done
    const finalOffset = liveRes?.offset ?? catchUp.offset
    console.log(
      `[agent] ${shortName} — idle timeout, acking offset=${finalOffset}`
    )

    const ackSpan = tracer.startSpan(
      `agent.ack_and_done`,
      { attributes: { "agent.final_offset": finalOffset } },
      rootCtx
    )

    await fetch(callback, {
      method: `POST`,
      headers: {
        "content-type": `application/json`,
        authorization: `Bearer ${activeToken}`,
      },
      body: JSON.stringify({
        epoch,
        acks: [{ path: streamPath, offset: finalOffset }],
        done: true,
      }),
    })

    ackSpan.end()
    console.log(`[agent] ${shortName} — done → IDLE`)
  } catch (err) {
    rootSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : `unknown error`,
    })
    throw err
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    rootSpan.end()
  }
}

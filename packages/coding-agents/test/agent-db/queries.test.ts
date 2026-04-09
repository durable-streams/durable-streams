import { describe, expect, it } from "vitest"
import {
  createAgentTimelineQuery,
  createPendingApprovalsQuery,
  normalizeAgentTimelineRow,
} from "../../src/agent-db-queries.js"
import { createAgentDB } from "../../src/agent-db.js"
import type { AgentTimelineQueryRow } from "../../src/agent-db-queries.js"

describe(`agentdb queries`, () => {
  it(`builds timeline rows with concatenated message text`, async () => {
    const db = createAgentDB({
      streamOptions: {
        url: `https://example.com/streams/session-1`,
        contentType: `application/json`,
      },
    })

    db.collections.sessions.insert({
      id: `session-1`,
      streamId: `session-1`,
      status: `initialized`,
    })
    db.collections.participants.insert({
      id: `Alice<alice@example.com>`,
      sessionId: `session-1`,
      name: `Alice`,
      email: `alice@example.com`,
    })
    db.collections.messages.insert({
      id: `message-1`,
      sessionId: `session-1`,
      participantId: `Alice<alice@example.com>`,
      role: `user`,
      kind: `user_message`,
      createdAt: `2026-04-07T00:00:00.000Z`,
      completedAt: `2026-04-07T00:00:00.000Z`,
      status: `completed`,
    })
    db.collections.message_parts.insert({
      id: `part-1`,
      messageId: `message-1`,
      sessionId: `session-1`,
      partIndex: 0,
      kind: `text`,
      text: `hello `,
      createdAt: `2026-04-07T00:00:00.000Z`,
    })
    db.collections.message_parts.insert({
      id: `part-2`,
      messageId: `message-1`,
      sessionId: `session-1`,
      partIndex: 1,
      kind: `text`,
      text: `world`,
      createdAt: `2026-04-07T00:00:01.000Z`,
    })
    db.collections.session_events.insert({
      id: `event-1`,
      sessionId: `session-1`,
      kind: `session_started`,
      createdAt: `2026-04-06T23:59:59.000Z`,
    })

    const timeline = createAgentTimelineQuery(db, `session-1`)
    await timeline.preload()

    const row = timeline.toArray[0] as AgentTimelineQueryRow | undefined
    expect(row).toBeDefined()
    expect(row?.messages).toHaveLength(1)
    expect(row?.messages[0]).toMatchObject({
      id: `message-1`,
      text: `hello world`,
    })

    const entries = normalizeAgentTimelineRow(
      row as unknown as AgentTimelineQueryRow
    )
    expect(entries.map((entry) => entry.kind)).toEqual([
      `session_event`,
      `user_message`,
    ])
    expect(entries[1]).toMatchObject({
      text: `hello world`,
      participant: {
        id: `Alice<alice@example.com>`,
      },
    })

    await timeline.cleanup()
  })

  it(`returns only pending approval requests`, async () => {
    const db = createAgentDB({
      streamOptions: {
        url: `https://example.com/streams/session-1`,
        contentType: `application/json`,
      },
    })

    db.collections.permission_requests.insert({
      id: `perm-1`,
      sessionId: `session-1`,
      status: `pending`,
      requestedAt: `2026-04-07T00:00:00.000Z`,
    })
    db.collections.permission_requests.insert({
      id: `perm-2`,
      sessionId: `session-1`,
      status: `approved`,
      requestedAt: `2026-04-07T00:00:01.000Z`,
    })
    db.collections.permission_requests.insert({
      id: `perm-3`,
      sessionId: `session-2`,
      status: `pending`,
      requestedAt: `2026-04-07T00:00:02.000Z`,
    })

    const pending = createPendingApprovalsQuery(db, `session-1`)
    await pending.preload()

    expect(pending.toArray).toHaveLength(1)
    expect(pending.toArray[0]).toMatchObject({
      id: `perm-1`,
      status: `pending`,
      sessionId: `session-1`,
    })

    await pending.cleanup()
  })
})

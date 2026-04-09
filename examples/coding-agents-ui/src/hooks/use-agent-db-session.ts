import { useEffect, useState } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import {
  createAgentDB,
  createAgentTimelineQuery,
  createPendingApprovalsQuery,
  createSessionHeaderQuery,
  normalizeAgentTimelineRow,
} from "@durable-streams/coding-agents/agent-db"
import type {
  AgentTimelineQueryRow,
  PermissionRequestRow,
  SessionRow,
} from "@durable-streams/coding-agents/agent-db"

const EMPTY_TIMELINE_ROW: AgentTimelineQueryRow = {
  id: ``,
  participants: [],
  messages: [],
  toolCalls: [],
  permissionRequests: [],
  approvalResponses: [],
  sessionEvents: [],
  turns: [],
}

export function useAgentDBSession(
  streamUrl: string,
  sessionId: string,
  enabled = true
) {
  const [error, setError] = useState<string | null>(null)
  const [db] = useState(() => {
    console.debug(`[agent-db] create`, {
      sessionId,
      streamUrl,
    })

    return createAgentDB({
      streamOptions: {
        url: streamUrl,
        contentType: `application/json`,
      },
    })
  })

  useEffect(() => {
    let cancelled = false
    setError(null)

    if (!enabled) {
      console.debug(`[agent-db] preload:skipped`, {
        sessionId,
        streamUrl,
      })
      return
    }

    console.debug(`[agent-db] preload:start`, {
      sessionId,
      streamUrl,
    })

    void db
      .preload()
      .then(() => {
        if (cancelled) {
          return
        }

        console.debug(`[agent-db] preload:ready`, {
          sessionId,
          streamUrl,
        })
      })
      .catch((preloadError: unknown) => {
        if (cancelled) {
          return
        }

        const message =
          preloadError instanceof Error
            ? preloadError.message
            : String(preloadError)

        console.error(`[agent-db] preload:error`, {
          sessionId,
          streamUrl,
          error: preloadError,
          message,
        })

        setError(message)
      })

    return () => {
      cancelled = true
      console.debug(`[agent-db] close`, {
        sessionId,
        streamUrl,
      })
      db.close()
    }
  }, [db, enabled, sessionId, streamUrl])

  const { data: timelineRows = [] } = useLiveQuery(
    () => createAgentTimelineQuery(db, sessionId),
    [db, sessionId]
  )
  const { data: pendingApprovalRows = [] } = useLiveQuery(
    () => createPendingApprovalsQuery(db, sessionId),
    [db, sessionId]
  )
  const { data: sessionHeaderRows = [] } = useLiveQuery(
    () => createSessionHeaderQuery(db, sessionId),
    [db, sessionId]
  )

  const timelineRow = (timelineRows[0] ??
    EMPTY_TIMELINE_ROW) as AgentTimelineQueryRow
  const timelineEntries = normalizeAgentTimelineRow(timelineRow)
  const pendingApprovals = pendingApprovalRows as Array<PermissionRequestRow>
  const sessionHeader = (sessionHeaderRows[0] ?? undefined) as
    | SessionRow
    | undefined

  useEffect(() => {
    console.debug(`[agent-db] query:timeline`, {
      sessionId,
      rowCount: timelineRows.length,
      rawRow: timelineRows[0],
      entryCount: timelineEntries.length,
      firstEntry: timelineEntries[0],
      lastEntry:
        timelineEntries.length > 0
          ? timelineEntries[timelineEntries.length - 1]
          : undefined,
    })
  }, [sessionId, timelineEntries, timelineRows])

  useEffect(() => {
    console.debug(`[agent-db] query:pending-approvals`, {
      sessionId,
      count: pendingApprovals.length,
      rows: pendingApprovals,
    })
  }, [pendingApprovals, sessionId])

  useEffect(() => {
    console.debug(`[agent-db] query:session-header`, {
      sessionId,
      rowCount: sessionHeaderRows.length,
      sessionHeader,
    })
  }, [sessionHeader, sessionHeaderRows, sessionId])

  useEffect(() => {
    if (!error) {
      return
    }

    console.error(`[agent-db] state:error`, {
      sessionId,
      streamUrl,
      error,
    })
  }, [error, sessionId, streamUrl])

  return {
    db,
    timelineRow,
    timelineEntries,
    pendingApprovals,
    sessionHeader,
    error,
  }
}

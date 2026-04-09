import { createSession } from "@durable-streams/coding-agents"
import { buildClientStreamUrl } from "./client-stream-url"
import {
  getSessionRecord,
  listSessionRecords,
  toSessionSummary,
} from "./session-store"
import type { Session } from "@durable-streams/coding-agents"
import type { SessionRecord, SessionSummary } from "./session-types"

interface ManagedSessionState {
  sessions: Map<string, Session>
}

declare global {
  var __codingAgentsUiState__: ManagedSessionState | undefined
}

function getState(): ManagedSessionState {
  if (!globalThis.__codingAgentsUiState__) {
    globalThis.__codingAgentsUiState__ = {
      sessions: new Map<string, Session>(),
    }
  }

  return globalThis.__codingAgentsUiState__
}

function isCodex(record: SessionRecord): boolean {
  return record.agent === `codex`
}

export function isSessionActive(id: string): boolean {
  return getState().sessions.has(id)
}

export async function stopManagedSession(id: string): Promise<void> {
  const session = getState().sessions.get(id)
  if (!session) {
    return
  }

  getState().sessions.delete(id)
  await session.close()
}

export async function startManagedSession(
  record: SessionRecord,
  mode: `start` | `resume`
): Promise<void> {
  await stopManagedSession(record.id)

  const session = await createSession({
    agent: record.agent,
    streamUrl: record.upstreamStreamUrl,
    cwd: record.cwd,
    model: record.model,
    permissionMode: record.permissionMode,
    approvalPolicy: isCodex(record) ? record.approvalPolicy : undefined,
    sandboxMode: isCodex(record) ? record.sandboxMode : undefined,
    developerInstructions: isCodex(record)
      ? record.developerInstructions
      : undefined,
    experimentalFeatures: isCodex(record)
      ? Object.fromEntries(
          record.experimentalFeatures.map((feature) => [feature, true])
        )
      : undefined,
    debugStream: record.debugStream,
    resume: mode === `resume`,
  })

  getState().sessions.set(record.id, session)
}

export async function listSessionSummaries(): Promise<Array<SessionSummary>> {
  const records = await listSessionRecords()
  return records.map((record) =>
    toSessionSummary(
      record,
      isSessionActive(record.id),
      buildClientStreamUrl(record.id)
    )
  )
}

export async function getSessionSummary(
  id: string
): Promise<SessionSummary | null> {
  const record = await getSessionRecord(id)
  if (!record) {
    return null
  }

  return toSessionSummary(
    record,
    isSessionActive(record.id),
    buildClientStreamUrl(record.id)
  )
}

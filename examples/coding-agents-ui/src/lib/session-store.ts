import { randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { buildUpstreamStreamUrl } from "./config"
import type {
  CreateSessionPayload,
  SessionRecord,
  SessionSummary,
} from "./session-types"

const SESSIONS_DIR = join(process.cwd(), `.coding-agents-sessions`)

async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true })
}

function sessionFilePath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`)
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function buildSessionRecord(
  payload: CreateSessionPayload
): SessionRecord {
  const id = randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  const cwd = payload.cwd.trim()
  const title =
    trimOptional(payload.title) ?? `${payload.agent} · ${basename(cwd)}`

  return {
    id,
    title,
    agent: payload.agent,
    cwd,
    model: trimOptional(payload.model),
    permissionMode: trimOptional(payload.permissionMode),
    approvalPolicy: payload.approvalPolicy,
    sandboxMode: payload.sandboxMode,
    developerInstructions: trimOptional(payload.developerInstructions),
    experimentalFeatures: Array.from(
      new Set((payload.experimentalFeatures ?? []).filter(Boolean))
    ),
    debugStream: payload.debugStream === true,
    upstreamStreamUrl: buildUpstreamStreamUrl(id),
    createdAt: now,
    updatedAt: now,
  }
}

export async function saveSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionsDir()
  await writeFile(sessionFilePath(record.id), JSON.stringify(record, null, 2))
}

export async function getSessionRecord(
  id: string
): Promise<SessionRecord | null> {
  await ensureSessionsDir()

  try {
    const raw = await readFile(sessionFilePath(id), `utf8`)
    return JSON.parse(raw) as SessionRecord
  } catch (error) {
    if (
      typeof error === `object` &&
      error !== null &&
      `code` in error &&
      (error as { code?: unknown }).code === `ENOENT`
    ) {
      return null
    }

    throw error
  }
}

export async function listSessionRecords(): Promise<Array<SessionRecord>> {
  await ensureSessionsDir()
  const files = (await readdir(SESSIONS_DIR)).filter((file) =>
    file.endsWith(`.json`)
  )
  const records: Array<SessionRecord> = []

  for (const file of files) {
    const raw = await readFile(join(SESSIONS_DIR, file), `utf8`)
    records.push(JSON.parse(raw) as SessionRecord)
  }

  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return records
}

export async function touchSessionRecord(id: string): Promise<void> {
  const record = await getSessionRecord(id)
  if (!record) {
    return
  }

  record.updatedAt = new Date().toISOString()
  await saveSessionRecord(record)
}

export function toSessionSummary(
  record: SessionRecord,
  active: boolean,
  clientStreamUrl: string
): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    agent: record.agent,
    cwd: record.cwd,
    model: record.model,
    permissionMode: record.permissionMode,
    approvalPolicy: record.approvalPolicy,
    sandboxMode: record.sandboxMode,
    developerInstructions: record.developerInstructions,
    experimentalFeatures: record.experimentalFeatures,
    debugStream: record.debugStream,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active,
    clientStreamUrl,
  }
}

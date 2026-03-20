import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ChatSummary } from "~/lib/chat-types"

const CHATS_DIR = path.join(process.cwd(), `.chats`)

function ensureDir() {
  if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true })
}

function chatFile(id: string) {
  ensureDir()
  return path.join(CHATS_DIR, `${id}.json`)
}

type ChatData = ChatSummary

/** Creates a new local chat metadata record and returns its id. */
export async function createChat(): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8)
  const data: ChatData = {
    id,
    createdAt: new Date().toISOString(),
    title: `New chat`,
  }
  await writeFile(chatFile(id), JSON.stringify(data, null, 2))
  return id
}

async function loadChat(id: string): Promise<ChatData> {
  const raw = await readFile(chatFile(id), `utf8`)
  return JSON.parse(raw) as ChatData
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === `object` &&
    error !== null &&
    `code` in error &&
    (error as { code?: unknown }).code === `ENOENT`
  )
}

/** Loads chat metadata, or null when the chat file is missing. */
export async function loadChatIfExists(id: string): Promise<ChatData | null> {
  try {
    return await loadChat(id)
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

async function upsertChatTitle(id: string, title: string): Promise<void> {
  let data: ChatData
  try {
    data = await loadChat(id)
  } catch {
    data = {
      id,
      createdAt: new Date().toISOString(),
      title: `New chat`,
    }
  }
  data.title = title
  await writeFile(chatFile(id), JSON.stringify(data, null, 2))
}

type TitleMessage = {
  role?: string
  parts?: Array<{ type?: string; content?: string }>
}

function deriveTitle(messages: Array<TitleMessage>): string {
  const first = messages.find((m) => m.role === `user`)
  if (!first) return `New chat`
  const text = (first.parts ?? [])
    .filter((p) => p.type === `text`)
    .map((p) => p.content ?? ``)
    .join(``)
  if (text.length <= 40) return text
  return text.slice(0, 40) + `…`
}

/** Updates chat title based on the first user message in the request. */
export async function saveChatMessages({
  id,
  messages,
}: {
  id: string
  messages: Array<TitleMessage>
}): Promise<void> {
  await upsertChatTitle(id, deriveTitle(messages))
}

/** Lists chat metadata for the sidebar, newest first. */
export async function listChats(): Promise<Array<ChatSummary>> {
  ensureDir()
  const files = readdirSync(CHATS_DIR).filter((f) => f.endsWith(`.json`))
  const chats: Array<ChatSummary> = []
  for (const file of files) {
    try {
      const raw = await readFile(path.join(CHATS_DIR, file), `utf8`)
      const data = JSON.parse(raw) as ChatData
      chats.push({ id: data.id, title: data.title, createdAt: data.createdAt })
    } catch {
      // skip corrupt files
    }
  }
  chats.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return chats
}

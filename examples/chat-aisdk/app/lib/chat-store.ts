import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { UIMessage } from "ai"

const CHATS_DIR = path.join(process.cwd(), `.chats`)

function ensureDir() {
  if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true })
}

function chatFile(id: string) {
  ensureDir()
  return path.join(CHATS_DIR, `${id}.json`)
}

interface ChatData {
  id: string
  messages: Array<UIMessage>
  createdAt: string
  title: string
  activeStreamId: string | null
}

export async function createChat(): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8)
  const data: ChatData = {
    id,
    messages: [],
    createdAt: new Date().toISOString(),
    title: `New chat`,
    activeStreamId: null,
  }
  await writeFile(chatFile(id), JSON.stringify(data, null, 2))
  return id
}

export async function loadChat(id: string): Promise<ChatData> {
  const raw = await readFile(chatFile(id), `utf8`)
  const parsed = JSON.parse(raw) as Partial<ChatData>
  return {
    id: parsed.id ?? id,
    messages: parsed.messages ?? [],
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    title: parsed.title ?? `New chat`,
    activeStreamId: parsed.activeStreamId ?? null,
  }
}

export async function saveChat({
  id,
  messages,
  title,
  activeStreamId,
}: {
  id: string
  messages?: Array<UIMessage>
  title?: string
  activeStreamId?: string | null
}): Promise<void> {
  let data: ChatData
  try {
    data = await loadChat(id)
  } catch {
    data = {
      id,
      messages: [],
      createdAt: new Date().toISOString(),
      title: `New chat`,
      activeStreamId: null,
    }
  }
  if (messages) data.messages = messages
  if (title) data.title = title
  if (activeStreamId !== undefined) data.activeStreamId = activeStreamId
  await writeFile(chatFile(id), JSON.stringify(data, null, 2))
}

function deriveTitle(messages: Array<UIMessage>): string {
  const first = messages.find((m) => m.role === `user`)
  if (!first) return `New chat`
  const text = first.parts
    .filter((p) => p.type === `text`)
    .map((p) => (`text` in p ? p.text : ``))
    .join(``)
  if (text.length <= 40) return text
  return text.slice(0, 40) + `…`
}

export async function saveChatMessages({
  id,
  messages,
}: {
  id: string
  messages: Array<UIMessage>
}): Promise<void> {
  const title = deriveTitle(messages)
  await saveChat({ id, messages, title })
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: string
}

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

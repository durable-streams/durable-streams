export interface ChatNode {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  parentId: string | null
  childIds: Array<string>
  forkedFromMessageId: string | null
  forkOffset: string | null
  sourceStreamPath: string
  depth: number
}

export interface ChatTreeState {
  version: 1
  activeChatId: string | null
  rootChatIds: Array<string>
  chatsById: Partial<Record<string, ChatNode>>
}

const STORAGE_KEY = `durable-chat-tree`

function freshState(): ChatTreeState {
  return {
    version: 1,
    activeChatId: null,
    rootChatIds: [],
    chatsById: {},
  }
}

export function loadTree(): ChatTreeState {
  if (typeof window === `undefined`) return freshState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return freshState()
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1) return freshState()
    return parsed as ChatTreeState
  } catch {
    return freshState()
  }
}

export function saveTree(state: ChatTreeState): void {
  if (typeof window === `undefined`) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // storage full or unavailable
  }
}

export function createRootNode(
  id: string,
  streamPath: string,
  title = `New chat`
): ChatNode {
  const now = new Date().toISOString()
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    parentId: null,
    childIds: [],
    forkedFromMessageId: null,
    forkOffset: null,
    sourceStreamPath: streamPath,
    depth: 0,
  }
}

export function insertRootChat(
  state: ChatTreeState,
  node: ChatNode
): ChatTreeState {
  return {
    ...state,
    rootChatIds: [node.id, ...state.rootChatIds],
    chatsById: { ...state.chatsById, [node.id]: node },
    activeChatId: node.id,
  }
}

export function insertForkChild(
  state: ChatTreeState,
  child: ChatNode
): ChatTreeState {
  const parentId = child.parentId
  const updatedChats: typeof state.chatsById = {
    ...state.chatsById,
    [child.id]: child,
  }

  if (parentId) {
    const parent = updatedChats[parentId]
    if (parent) {
      updatedChats[parentId] = {
        ...parent,
        childIds: [...parent.childIds, child.id],
        updatedAt: new Date().toISOString(),
      }
    }
  }

  return {
    ...state,
    chatsById: updatedChats,
    activeChatId: child.id,
  }
}

export function setActiveChat(
  state: ChatTreeState,
  chatId: string
): ChatTreeState {
  const node = state.chatsById[chatId]
  if (node) {
    return {
      ...state,
      activeChatId: chatId,
      chatsById: {
        ...state.chatsById,
        [chatId]: { ...node, updatedAt: new Date().toISOString() },
      },
    }
  }
  return { ...state, activeChatId: chatId }
}

export function updateTitle(
  state: ChatTreeState,
  chatId: string,
  title: string
): ChatTreeState {
  const node = state.chatsById[chatId]
  if (!node) return state
  return {
    ...state,
    chatsById: {
      ...state.chatsById,
      [chatId]: { ...node, title, updatedAt: new Date().toISOString() },
    },
  }
}

export function backfillMinimalNode(
  state: ChatTreeState,
  chatId: string,
  streamPath: string
): ChatTreeState {
  if (state.chatsById[chatId]) return state
  const node = createRootNode(chatId, streamPath, `Restored chat`)
  return {
    ...state,
    rootChatIds: [chatId, ...state.rootChatIds],
    chatsById: { ...state.chatsById, [chatId]: node },
    activeChatId: chatId,
  }
}

export function getAncestry(
  state: ChatTreeState,
  chatId: string
): Array<ChatNode> {
  const result: Array<ChatNode> = []
  let current = state.chatsById[chatId]
  while (current) {
    result.unshift(current)
    current = current.parentId ? state.chatsById[current.parentId] : undefined
  }
  return result
}

export function getRootNodes(state: ChatTreeState): Array<ChatNode> {
  return state.rootChatIds
    .map((id) => state.chatsById[id])
    .filter(Boolean) as Array<ChatNode>
}

function deriveTitle(firstUserText: string): string {
  if (!firstUserText) return `New chat`
  const trimmed = firstUserText.trim()
  if (trimmed.length <= 40) return trimmed
  return trimmed.slice(0, 40) + `…`
}

export function deriveTitleFromMessages(
  messages: Array<{
    role?: string
    parts?: Array<{ type?: string; content?: string }>
  }>
): string {
  const first = messages.find((m) => m.role === `user`)
  if (!first) return `New chat`
  const text = (first.parts ?? [])
    .filter((p) => p.type === `text`)
    .map((p) => p.content ?? ``)
    .join(``)
  return deriveTitle(text)
}

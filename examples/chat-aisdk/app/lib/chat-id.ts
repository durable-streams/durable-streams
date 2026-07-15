import path from "node:path"

export const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function assertValidChatId(id: unknown): asserts id is string {
  if (typeof id !== `string` || !CHAT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid chat id`)
  }
}

export function resolveChatFile(chatsDir: string, id: unknown): string {
  assertValidChatId(id)
  const root = path.resolve(chatsDir)
  const file = path.resolve(root, `${id}.json`)
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`Invalid chat id`)
  return file
}

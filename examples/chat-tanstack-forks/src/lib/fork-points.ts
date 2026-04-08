import type {
  CustomChunkHandler,
  OnMessageWritten,
} from "@durable-streams/tanstack-ai-transport"

export const FORK_POINT_MARKER_NAME = `durable-message-offset`

export interface DurableMessageMetadata {
  endOffset?: string
  forkPoint?: boolean
  inheritedForkPoint?: boolean
  sourceStreamPath?: string
}

export function getDurableMetadata(
  message: any
): DurableMessageMetadata | undefined {
  return message?.metadata?.durable
}

export function isForkable(message: any): boolean {
  const meta = getDurableMetadata(message)
  return typeof meta?.endOffset === `string` && meta.endOffset.length > 0
}

export function getForkOffset(message: any): string | undefined {
  return getDurableMetadata(message)?.endOffset
}

/**
 * Server-side hook: writes a CUSTOM fork-point marker after each message,
 * recording the stream offset at that message boundary.
 */
export const onForkPointMessageWritten: OnMessageWritten = async ({
  messageId,
  offset,
  append,
  flush,
}) => {
  const marker = {
    type: `CUSTOM`,
    timestamp: Date.now(),
    name: FORK_POINT_MARKER_NAME,
    value: {
      version: 1,
      messageId,
      endOffset: offset,
    },
  }
  append(JSON.stringify(marker))
  await flush()
}

/**
 * Client-side hook: applies fork-point metadata from CUSTOM chunks
 * onto the corresponding messages.
 */
export const forkPointCustomChunkHandler: CustomChunkHandler = (
  chunk,
  messages
) => {
  const name = (chunk as { name?: unknown }).name
  if (name !== FORK_POINT_MARKER_NAME) return undefined

  const value = (chunk as { value?: any }).value
  if (!value || typeof value !== `object`) return undefined
  const { messageId, endOffset, inherited, sourceStreamPath } = value
  if (typeof messageId !== `string` || typeof endOffset !== `string`)
    return undefined

  const index = messages.findIndex((m) => m?.id === messageId)
  if (index < 0) return undefined

  const updated = [...messages]
  const msg = updated[index]
  updated[index] = {
    ...msg,
    metadata: {
      ...(msg.metadata ?? {}),
      durable: {
        ...(msg.metadata?.durable ?? {}),
        endOffset,
        forkPoint: true,
        ...(inherited ? { inheritedForkPoint: true } : {}),
        ...(sourceStreamPath ? { sourceStreamPath } : {}),
      },
    },
  }
  return updated
}

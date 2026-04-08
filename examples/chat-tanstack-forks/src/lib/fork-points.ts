import type { DurableMessageMetadata } from "@durable-streams/tanstack-ai-transport"

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

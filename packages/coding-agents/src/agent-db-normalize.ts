import type { AgentType, StreamEnvelope, UserEnvelope } from "./types.js"

export function normalizeAgentDBTimestamp(
  value: string | number | Date
): string {
  return new Date(value).toISOString()
}

export function createAgentDBStreamId(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split(`/`).filter(Boolean)
    return segments.at(-1) ?? url
  } catch {
    return url
  }
}

export function createAgentDBRowId(
  sequence: number,
  suffix?: string | number
): string {
  return suffix == null ? `row:${sequence}` : `row:${sequence}:${suffix}`
}

export function createAgentDBTxRowId(
  txid: string,
  suffix?: string | number
): string {
  return suffix == null ? `tx:${txid}` : `tx:${txid}:${suffix}`
}

export function createAgentDBParticipantId(user: UserEnvelope[`user`]): string {
  return `${user.name}<${user.email}>`
}

export function isUserMessageEnvelope(
  envelope: StreamEnvelope
): envelope is UserEnvelope<{ type: `user_message`; text: string }> {
  return (
    envelope.direction === `user` &&
    typeof envelope.raw === `object` &&
    `type` in envelope.raw &&
    envelope.raw.type === `user_message`
  )
}

export function normalizeAgentDBProvider(agent: AgentType): string {
  return agent
}

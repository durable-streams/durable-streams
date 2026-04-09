import type { ControlResponseIntent, User } from "./types.js"

export function formatPromptForAgent(text: string, user?: User): string {
  if (!user) {
    return text
  }

  return [
    `[Current speaker]`,
    `name: ${user.name}`,
    `email: ${user.email}`,
    `Interpret first-person references like "I", "me", "my", "mine", "we", and "our" as referring to this speaker unless the message says otherwise.`,
    ``,
    `[User message]`,
    text,
  ].join(`\n`)
}

function extractApprovalTarget(raw?: object): string | undefined {
  if (!raw || typeof raw !== `object`) {
    return undefined
  }

  const record = raw as Record<string, unknown>

  if (record.type === `control_request`) {
    const request = record.request as Record<string, unknown> | undefined
    const toolName = request?.tool_name
    const input = request?.input as Record<string, unknown> | undefined

    if (typeof toolName === `string` && typeof input?.command === `string`) {
      return `${toolName} command "${input.command}"`
    }

    if (typeof toolName === `string`) {
      return `${toolName} request`
    }
  }

  const method = record.method
  const params = record.params as Record<string, unknown> | undefined

  if (
    method === `item/commandExecution/requestApproval` &&
    typeof params?.command === `string`
  ) {
    return `command "${params.command}"`
  }

  if (method === `item/fileChange/requestApproval`) {
    const changes = params?.changes
    if (Array.isArray(changes) && changes.length > 0) {
      const firstChange = changes[0] as Record<string, unknown>
      if (typeof firstChange.path === `string`) {
        return `file change "${firstChange.path}"`
      }
    }
    return `file change request`
  }

  if (method === `item/permissions/requestApproval`) {
    return `permissions request`
  }

  if (method === `item/tool/requestUserInput`) {
    return `user input request`
  }

  return undefined
}

function describeApprovalDecision(intent: ControlResponseIntent): string {
  if (intent.response.subtype === `cancelled`) {
    return `cancelled`
  }

  const response = intent.response.response as Record<string, unknown>
  const behavior = response.behavior

  if (typeof behavior === `string`) {
    switch (behavior) {
      case `allow`:
        return `approved`
      case `allow_for_session`:
        return `approved for the rest of this session`
      case `deny`:
        return `denied`
      default:
        return `responded with behavior "${behavior}"`
    }
  }

  if (`permissions` in response) {
    return `granted permissions`
  }

  if (`answers` in response) {
    return `answered the requested questions`
  }

  return `responded`
}

export function formatApprovalNoteForAgent(
  intent: ControlResponseIntent,
  requestRaw?: object
): string {
  const decision = describeApprovalDecision(intent)
  const target = extractApprovalTarget(requestRaw)
  const targetSuffix = target ? ` for ${target}` : ``

  return [
    `[Approval response]`,
    `I ${decision}${targetSuffix}.`,
    `If anyone later asks who handled this approval, I was the user who responded to request ${String(intent.response.request_id)}.`,
  ].join(`\n`)
}

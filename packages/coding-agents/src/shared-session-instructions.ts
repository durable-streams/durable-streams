const SHARED_SESSION_INSTRUCTIONS: string = [
  `This is a shared multi-user coding session.`,
  ``,
  `Each incoming user message may be authored by a different person.`,
  `Forwarded user prompts include an explicit current-speaker block with that person's name and email.`,
  `Treat that current-speaker block as the authoritative speaker identity.`,
  ``,
  `Rules:`,
  `1. Do not assume consecutive user messages come from the same person.`,
  `2. When replying, avoid ambiguous "you" if multiple users are active; use names when helpful.`,
  `3. Before taking significant action, keep track of which user requested it.`,
  `4. If users give conflicting directions, surface the conflict explicitly instead of guessing.`,
  `5. Approvals, interrupts, and follow-up prompts may come from any participant; respond to the actual speaker and current transcript state.`,
  `6. Sessions may be resumed or joined mid-stream, so keep plans, decisions, and pending questions easy for another collaborator to follow.`,
].join(`\n`)

export function getSharedSessionInstructions(
  developerInstructions?: string
): string {
  if (!developerInstructions?.trim()) {
    return SHARED_SESSION_INSTRUCTIONS
  }

  return `${SHARED_SESSION_INSTRUCTIONS}\n\n${developerInstructions.trim()}`
}

export { SHARED_SESSION_INSTRUCTIONS }

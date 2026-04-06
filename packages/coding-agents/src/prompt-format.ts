import type { User } from "./types.js"

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

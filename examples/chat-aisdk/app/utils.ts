export function assertOpenAiApiKeyConfigured(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(`OPENAI_API_KEY is not configured`)
  }
}

import type { EnvConfig } from "./types"

// Server-side environment configuration
// These values should be set as environment variables
export function getEnvConfig(): EnvConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  const githubToken = process.env.GITHUB_TOKEN
  const durableStreamsUrl =
    process.env.DURABLE_STREAMS_URL || "http://localhost:4437"
  const modalApiUrl = process.env.MODAL_API_URL
  const sessionApiToken = process.env.SESSION_API_TOKEN
  const idleTimeoutMs = parseInt(
    process.env.IDLE_TIMEOUT_MS || "300000",
    10
  ) // 5 minutes default

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required")
  }

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN environment variable is required")
  }

  return {
    anthropicApiKey,
    githubToken,
    durableStreamsUrl,
    modalApiUrl,
    sessionApiToken,
    idleTimeoutMs,
  }
}

// Generate a token for session API authentication
export function generateSessionToken(sessionId: string): string {
  // In production, use a proper JWT or signed token
  // For simplicity, we use a basic token format
  const baseToken = process.env.SESSION_API_TOKEN || "dev-token"
  return `${baseToken}:${sessionId}`
}

// Validate session token
export function validateSessionToken(
  token: string,
  sessionId: string
): boolean {
  const baseToken = process.env.SESSION_API_TOKEN || "dev-token"
  return token === `${baseToken}:${sessionId}`
}

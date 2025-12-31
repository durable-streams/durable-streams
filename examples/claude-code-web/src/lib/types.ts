import { z } from "zod"

// Container lifecycle states
export const ContainerState = {
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  IDLE: "idle",
} as const

export type ContainerState = (typeof ContainerState)[keyof typeof ContainerState]

// Session data model
export const SessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  branch: z.string().optional(),
  state: z.enum(["stopped", "starting", "running", "idle"]),
  sandboxId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  idleTimerStartedAt: z.string().nullable(),
})

export type Session = z.infer<typeof SessionSchema>

// Create session request
export const CreateSessionSchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
  branch: z.string().optional(),
  name: z.string().optional(),
})

export type CreateSessionRequest = z.infer<typeof CreateSessionSchema>

// Spawn sub-instance request
export const SpawnRequestSchema = z.object({
  task: z.string(),
  context: z.string().optional(),
  branch: z.string(),
  parentSessionId: z.string(),
  repo: z.string(),
})

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>

// Session state update from hooks
export const SessionStateUpdateSchema = z.object({
  stopHookActive: z.boolean().optional(),
  reason: z.string().optional(),
})

export type SessionStateUpdate = z.infer<typeof SessionStateUpdateSchema>

// GitHub repository
export const GitHubRepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  fullName: z.string(),
  owner: z.object({
    login: z.string(),
    avatarUrl: z.string().optional(),
  }),
  description: z.string().nullable(),
  private: z.boolean(),
  defaultBranch: z.string(),
  cloneUrl: z.string(),
  htmlUrl: z.string(),
  updatedAt: z.string(),
})

export type GitHubRepo = z.infer<typeof GitHubRepoSchema>

// Direct access session
export const DirectAccessSchema = z.object({
  directSessionId: z.string(),
  inputStream: z.string(),
  outputStream: z.string(),
})

export type DirectAccess = z.infer<typeof DirectAccessSchema>

// Environment configuration
export interface EnvConfig {
  anthropicApiKey: string
  githubToken: string
  durableStreamsUrl: string
  modalApiUrl?: string
  sessionApiToken?: string
  idleTimeoutMs: number
}

// Stream identifiers for a session
export function getSessionStreams(sessionId: string) {
  return {
    input: `terminal/${sessionId}/input`,
    output: `terminal/${sessionId}/output`,
  }
}

// Modal sandbox configuration
export interface SandboxConfig {
  sessionId: string
  repoOwner: string
  repoName: string
  branch?: string
  anthropicApiKey: string
  githubToken: string
  apiUrl: string
  apiToken: string
  initialPrompt?: string
}

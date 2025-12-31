/**
 * Modal SDK wrapper for managing Claude Code sandboxes
 *
 * Note: This is a TypeScript interface for Modal's Python SDK.
 * In production, you would either:
 * 1. Use Modal's HTTP API directly
 * 2. Run a Python sidecar that exposes Modal operations
 * 3. Use Modal's upcoming Node.js SDK
 *
 * For this implementation, we simulate the Modal API with HTTP calls
 * to a Modal sidecar service.
 */

import type { SandboxConfig } from "./types"

export interface ModalSandbox {
  id: string
  status: "creating" | "running" | "stopped" | "error"
}

export interface ModalProcess {
  id: string
  sandboxId: string
  stdin: WritableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}

const MODAL_SIDECAR_URL =
  process.env.MODAL_SIDECAR_URL || "http://localhost:8080"

/**
 * Create a new Modal Sandbox with Claude Code
 */
export async function createSandbox(
  config: SandboxConfig
): Promise<ModalSandbox> {
  const response = await fetch(`${MODAL_SIDECAR_URL}/sandboxes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: config.sessionId,
      repo_owner: config.repoOwner,
      repo_name: config.repoName,
      branch: config.branch,
      secrets: {
        ANTHROPIC_API_KEY: config.anthropicApiKey,
        GITHUB_TOKEN: config.githubToken,
        CLAUDE_WEB_API_URL: config.apiUrl,
        CLAUDE_WEB_API_TOKEN: config.apiToken,
        SESSION_ID: config.sessionId,
        REPO_FULL_NAME: `${config.repoOwner}/${config.repoName}`,
      },
      initial_prompt: config.initialPrompt,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to create sandbox: ${error}`)
  }

  return response.json()
}

/**
 * Get sandbox status
 */
export async function getSandbox(
  sandboxId: string
): Promise<ModalSandbox | null> {
  const response = await fetch(`${MODAL_SIDECAR_URL}/sandboxes/${sandboxId}`)

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to get sandbox: ${response.statusText}`)
  }

  return response.json()
}

/**
 * Terminate a sandbox
 */
export async function terminateSandbox(sandboxId: string): Promise<void> {
  const response = await fetch(`${MODAL_SIDECAR_URL}/sandboxes/${sandboxId}`, {
    method: "DELETE",
  })

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to terminate sandbox: ${response.statusText}`)
  }
}

/**
 * Execute a command in a sandbox with PTY
 */
export async function execInSandbox(
  sandboxId: string,
  command: string[],
  env?: Record<string, string>
): Promise<{ processId: string }> {
  const response = await fetch(
    `${MODAL_SIDECAR_URL}/sandboxes/${sandboxId}/exec`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command,
        pty: true,
        env: {
          TERM: "xterm-256color",
          ...env,
        },
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to exec in sandbox: ${response.statusText}`)
  }

  return response.json()
}

/**
 * Write to a process stdin
 */
export async function writeToProcess(
  sandboxId: string,
  processId: string,
  data: Uint8Array
): Promise<void> {
  const response = await fetch(
    `${MODAL_SIDECAR_URL}/sandboxes/${sandboxId}/processes/${processId}/stdin`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: data,
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to write to process: ${response.statusText}`)
  }
}

/**
 * Create a stream reader for process stdout
 */
export function createProcessOutputStream(
  sandboxId: string,
  processId: string
): ReadableStream<Uint8Array> {
  const url = `${MODAL_SIDECAR_URL}/sandboxes/${sandboxId}/processes/${processId}/stdout`

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
          },
        })

        if (!response.ok) {
          controller.error(
            new Error(`Failed to connect to process: ${response.status}`)
          )
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          controller.error(new Error("No response body"))
          return
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }

        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * Resize PTY window
 */
export async function resizePty(
  sandboxId: string,
  processId: string,
  cols: number,
  rows: number
): Promise<void> {
  const response = await fetch(
    `${MODAL_SIDECAR_URL}/sandboxes/${sandboxId}/processes/${processId}/resize`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cols, rows }),
    }
  )

  if (!response.ok) {
    console.warn(`Failed to resize PTY: ${response.statusText}`)
  }
}

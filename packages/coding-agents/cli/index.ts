#!/usr/bin/env node

import { parseArgs } from "node:util"
import { createSession } from "../src/index.js"
import type { AgentType } from "../src/types.js"
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../src/protocol/codex.js"

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, ``)
}

function parseAgent(value: string | undefined): AgentType {
  if (value === `claude` || value === `codex`) {
    return value
  }

  throw new Error(`--agent must be either "claude" or "codex"`)
}

function parseBooleanLiteral(value: string, flagName: string): boolean {
  if (value === `true`) {
    return true
  }

  if (value === `false`) {
    return false
  }

  throw new Error(`${flagName} boolean values must be "true" or "false"`)
}

function parseCodexSandboxMode(
  value: string | undefined
): CodexSandboxMode | undefined {
  if (value === undefined) {
    return undefined
  }

  if (
    value === `read-only` ||
    value === `workspace-write` ||
    value === `danger-full-access`
  ) {
    return value
  }

  throw new Error(
    `--sandbox-mode must be one of "read-only", "workspace-write", or "danger-full-access"`
  )
}

function parseCodexApprovalPolicy(
  value: string | undefined
): CodexApprovalPolicy | undefined {
  if (value === undefined) {
    return undefined
  }

  if (
    value === `untrusted` ||
    value === `on-failure` ||
    value === `on-request` ||
    value === `never`
  ) {
    return value
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (
      parsed &&
      typeof parsed === `object` &&
      `granular` in parsed &&
      parsed.granular &&
      typeof parsed.granular === `object`
    ) {
      return parsed as CodexApprovalPolicy
    }
  } catch {}

  throw new Error(
    `--approval-policy must be one of "untrusted", "on-failure", "on-request", "never", or a JSON object like {"granular":{...}}`
  )
}

function parseExperimentalFeatures(
  values: Array<string> | undefined
): Record<string, boolean> | undefined {
  if (!values || values.length === 0) {
    return undefined
  }

  const features: Record<string, boolean> = {}
  for (const value of values) {
    const separatorIndex = value.indexOf(`=`)
    if (separatorIndex === -1) {
      features[value] = true
      continue
    }

    const key = value.slice(0, separatorIndex)
    const booleanValue = value.slice(separatorIndex + 1)
    if (!key) {
      throw new Error(
        `--experimental-feature entries must look like name or name=true`
      )
    }

    features[key] = parseBooleanLiteral(booleanValue, `--experimental-feature`)
  }

  return features
}

function parseEnv(
  values: Array<string> | undefined
): Record<string, string> | undefined {
  if (!values || values.length === 0) {
    return undefined
  }

  const env: Record<string, string> = {}
  for (const value of values) {
    const separatorIndex = value.indexOf(`=`)
    if (separatorIndex <= 0) {
      throw new Error(`--env entries must look like KEY=value`)
    }

    env[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1)
  }

  return env
}

function assertCodexOnlyFlags(
  agent: AgentType,
  flags: Record<string, unknown>
): void {
  if (agent === `codex`) {
    return
  }

  const usedFlags = Object.entries(flags)
    .filter(([, value]) => {
      if (value === undefined) {
        return false
      }

      if (Array.isArray(value)) {
        return value.length > 0
      }

      return true
    })
    .map(([name]) => name)

  if (usedFlags.length === 0) {
    return
  }

  throw new Error(
    `${usedFlags.join(`, `)} ${
      usedFlags.length === 1 ? `is` : `are`
    } only supported with --agent codex`
  )
}

function getUsageText(): string {
  return `Usage:
  coding-agents start  [options]
  coding-agents resume [options]

Options:
  --agent <claude|codex>   Agent to use (default: claude)
  --stream-url <url>       Durable stream URL
  --cwd <path>             Working directory (default: current directory)
  --model <model>          Model name
  --permission-mode <mode> Permission mode to pass through to the agent
  --approval-policy <mode-or-json>
                           Codex approval policy
  --sandbox-mode <mode>    Codex sandbox mode
  --developer-instructions <text>
                           Codex developer instructions
  --experimental-feature <name[=true|false]>
                           Enable a Codex experimental feature
  --env <KEY=value>        Extra environment variable for the agent process
  --verbose                Enable verbose agent output`
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: `string`, default: `claude` },
      "stream-url": { type: `string` },
      cwd: { type: `string`, default: process.cwd() },
      model: { type: `string` },
      "permission-mode": { type: `string` },
      "approval-policy": { type: `string` },
      "sandbox-mode": { type: `string` },
      "developer-instructions": { type: `string` },
      "experimental-feature": { type: `string`, multiple: true },
      env: { type: `string`, multiple: true },
      verbose: { type: `boolean`, default: false },
      help: { type: `boolean`, short: `h`, default: false },
    },
  })

  const command = positionals[0]
  if (values.help || command === undefined || command === `help`) {
    console.log(getUsageText())
    return
  }

  const agent = parseAgent(values.agent)
  assertCodexOnlyFlags(agent, {
    "--approval-policy": values[`approval-policy`],
    "--sandbox-mode": values[`sandbox-mode`],
    "--developer-instructions": values[`developer-instructions`],
    "--experimental-feature": values[`experimental-feature`],
    "--env": values.env,
  })

  const baseUrl = process.env.DURABLE_STREAMS_URL
    ? trimTrailingSlash(process.env.DURABLE_STREAMS_URL)
    : undefined

  let streamUrl = values[`stream-url`]
  if (command === `start` && !streamUrl && baseUrl) {
    streamUrl = `${baseUrl}/v1/stream/session-${Date.now()}`
  }

  if (!streamUrl) {
    throw new Error(
      command === `resume`
        ? `resume requires --stream-url`
        : `start requires --stream-url or DURABLE_STREAMS_URL`
    )
  }

  if (command !== `start` && command !== `resume`) {
    throw new Error(`Unknown command: ${command}`)
  }

  const approvalPolicy = parseCodexApprovalPolicy(values[`approval-policy`])
  const sandboxMode = parseCodexSandboxMode(values[`sandbox-mode`])
  const experimentalFeatures = parseExperimentalFeatures(
    values[`experimental-feature`]
  )
  const env = parseEnv(values.env)

  const session = await createSession({
    agent,
    streamUrl,
    cwd: values.cwd,
    model: values.model,
    permissionMode: values[`permission-mode`],
    approvalPolicy,
    sandboxMode,
    developerInstructions: values[`developer-instructions`],
    experimentalFeatures,
    env,
    verbose: values.verbose,
    resume: command === `resume`,
  })

  console.log(`Stream: ${session.streamUrl}`)
  console.log(command === `resume` ? `Session resumed.` : `Session started.`)

  const shutdown = async () => {
    await session.close()
  }

  process.once(`SIGINT`, () => {
    void shutdown().finally(() => {
      process.exit(0)
    })
  })

  process.once(`SIGTERM`, () => {
    void shutdown().finally(() => {
      process.exit(0)
    })
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

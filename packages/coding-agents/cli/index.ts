#!/usr/bin/env node

import { parseArgs } from "node:util"
import { createSession } from "../src/index.js"
import type { AgentType } from "../src/types.js"

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, ``)
}

function parseAgent(value: string | undefined): AgentType {
  if (value === `claude` || value === `codex`) {
    return value
  }

  throw new Error(`--agent must be either "claude" or "codex"`)
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

  const session = await createSession({
    agent,
    streamUrl,
    cwd: values.cwd,
    model: values.model,
    permissionMode: values[`permission-mode`],
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

#!/usr/bin/env node

/**
 * ds-cc: Share and follow Claude Code sessions via Durable Streams.
 */

import { share } from "./share.js"
import { follow } from "./follow.js"

const args = process.argv.slice(2)
const command = args[0]

function usage(): void {
  console.log(`Usage:
  ds-cc share [--session <id>] --server <url>    Share a CC session
  ds-cc follow <stream-url> [--from-beginning]   Follow a shared session

Examples:
  ds-cc share --server http://localhost:4437
  ds-cc follow http://localhost:4437/cc/47515c25-d702-4c25-b772-a2147aa63f56
`)
}

function parseArg(argv: Array<string>, flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= argv.length) return undefined
  return argv[idx + 1]
}

function hasFlag(argv: Array<string>, flag: string): boolean {
  return argv.includes(flag)
}

async function main(): Promise<void> {
  if (!command || command === `--help` || command === `-h`) {
    usage()
    process.exit(0)
  }

  if (command === `share`) {
    const server = parseArg(args, `--server`)
    if (!server) {
      console.error(`Error: --server <url> is required\n`)
      usage()
      process.exit(1)
    }

    const sessionId = parseArg(args, `--session`)
    await share({ server, sessionId })
  } else if (command === `follow`) {
    const streamUrl = args[1]
    if (!streamUrl || streamUrl.startsWith(`-`)) {
      console.error(`Error: stream URL is required\n`)
      usage()
      process.exit(1)
    }

    const fromBeginning = hasFlag(args, `--from-beginning`)
    await follow({ streamUrl, fromBeginning })
  } else {
    console.error(`Unknown command: ${command}\n`)
    usage()
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Error:`, err)
  process.exit(1)
})

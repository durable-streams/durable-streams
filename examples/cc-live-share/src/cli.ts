#!/usr/bin/env node

/**
 * ds-cc: Share and follow Claude Code sessions via Durable Streams.
 */

import { share } from "./share.js"
import { follow } from "./follow.js"
import { fork } from "./fork.js"
import { clone } from "./clone.js"
import { merge } from "./merge.js"

const args = process.argv.slice(2)
const command = args[0]

function usage(): void {
  console.log(`Usage:
  ds-cc share [--session <id>] --server <url>           Live-share a CC session
  ds-cc follow <stream-url> [--from-beginning]          Follow a shared session
  ds-cc fork [--session <id>] --server <url>            Fork (export) a CC session
  ds-cc clone <fork-url> [--resume] [--fast]             Clone (import) a forked session
  ds-cc merge <fork-url> --into <branch>                Merge a fork into a target branch

Examples:
  ds-cc share --server http://localhost:4437
  ds-cc follow http://localhost:4437/cc/47515c25-...
  ds-cc fork --server http://localhost:4437
  ds-cc clone http://localhost:4437/cc/47515c25-...
  ds-cc clone --resume http://localhost:4437/cc/47515c25-...
  ds-cc merge http://localhost:4437/cc/47515c25-... --into cc-session/clone-abc123
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

/**
 * Find the first positional argument (not a flag or flag value).
 */
function findPositionalArg(argv: Array<string>): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith(`-`)) {
      // Skip flag and its value
      if (
        arg === `--server` ||
        arg === `--session` ||
        arg === `--remote` ||
        arg === `--into`
      ) {
        i++ // skip the value
      }
      continue
    }
    return arg
  }
  return undefined
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
  } else if (command === `fork`) {
    const server = parseArg(args, `--server`)
    if (!server) {
      console.error(`Error: --server <url> is required\n`)
      usage()
      process.exit(1)
    }
    const sessionId = parseArg(args, `--session`)
    const remote = parseArg(args, `--remote`)
    await fork({ server, sessionId, remote })
  } else if (command === `clone`) {
    const forkUrl = findPositionalArg(args)
    if (!forkUrl) {
      console.error(`Error: fork URL is required\n`)
      usage()
      process.exit(1)
    }
    const resume = hasFlag(args, `--resume`)
    const fast = hasFlag(args, `--fast`)
    await clone({ forkUrl, resume, fast })
  } else if (command === `merge`) {
    const forkUrl = findPositionalArg(args)
    if (!forkUrl) {
      console.error(`Error: fork URL is required\n`)
      usage()
      process.exit(1)
    }
    const into = parseArg(args, `--into`)
    if (!into) {
      console.error(`Error: --into <branch> is required\n`)
      usage()
      process.exit(1)
    }
    await merge({ forkUrl, into })
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

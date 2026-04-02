#!/usr/bin/env node

/**
 * cods: Share and follow Claude Code sessions via Durable Streams.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { share } from "./share.js"
import { follow } from "./follow.js"
import { fork } from "./fork.js"
import { clone } from "./clone.js"
import { merge } from "./merge.js"

const args = process.argv.slice(2)
const command = args[0]

function usage(): void {
  console.log(`Usage:
  cods share [--session <id>] --server <url>           Live-share a CC session
  cods follow <stream-url> [--from-beginning]          Follow a shared session
  cods fork [--session <id>] --server <url>            Fork (export) a CC session
  cods clone <fork-url> [--resume] [--fast]             Clone (import) a forked session
  cods merge <session-id-A> <session-id-B>              Merge two local sessions
  cods install-skills [--global]                         Install /share, /fork and /merge skills into .claude/skills/

Examples:
  cods share --server http://localhost:4437
  cods follow http://localhost:4437/cc/47515c25-...
  cods fork --server http://localhost:4437
  cods clone http://localhost:4437/cc/47515c25-...
  cods clone --resume http://localhost:4437/cc/47515c25-...
  cods merge <session-id-A> <session-id-B>
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
      if (arg === `--server` || arg === `--session` || arg === `--remote`) {
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
    const sessionA = args[1]
    const sessionB = args[2]
    if (
      !sessionA ||
      !sessionB ||
      sessionA.startsWith(`-`) ||
      sessionB.startsWith(`-`)
    ) {
      console.error(`Error: two session IDs are required\n`)
      usage()
      process.exit(1)
    }
    await merge({ sessionA, sessionB })
  } else if (command === `install-skills`) {
    const skillsSource = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      `..`,
      `skills`
    )
    const global = hasFlag(args, `--global`)
    const targetDir = global
      ? path.join(os.homedir(), `.claude`, `skills`)
      : path.resolve(`.claude`, `skills`)
    fs.mkdirSync(targetDir, { recursive: true })

    for (const skill of [`share`, `fork`, `merge`]) {
      const target = path.join(targetDir, skill)
      const source = path.join(skillsSource, skill)
      if (fs.existsSync(target)) {
        console.log(`  ${skill}: already exists, skipping`)
      } else {
        fs.symlinkSync(source, target)
        console.log(`  ${skill}: linked → ${source}`)
      }
    }
    console.log(
      `\nSkills installed${global ? ` globally` : ``}. Use /share, /fork and /merge in Claude Code.`
    )
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

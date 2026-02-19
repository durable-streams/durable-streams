#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, watch } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ChildProcess } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ParsedArgs {
  mode: `run` | `watch`
  watchPaths: Array<string>
  baseUrl: string
  help: boolean
}

function printUsage() {
  console.log(`
Durable Streams Proxy Conformance Runner

Usage:
  npx durable-streams-proxy-conformance --run <url>
  npx durable-streams-proxy-conformance --watch <path> [path...] <url>

Options:
  --run              Run tests once and exit
  --watch <paths>    Watch source paths and rerun tests on changes
  --help, -h         Show this help message
`)
}

function parseArgs(args: Array<string>): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: `run`,
    watchPaths: [],
    baseUrl: ``,
    help: false,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === `--help` || arg === `-h`) {
      parsed.help = true
      return parsed
    }
    if (arg === `--run`) {
      parsed.mode = `run`
      i++
      continue
    }
    if (arg === `--watch`) {
      parsed.mode = `watch`
      i++
      while (i < args.length - 1) {
        const watchPath = args[i]!
        if (watchPath.startsWith(`-`)) break
        parsed.watchPaths.push(watchPath)
        i++
      }
      continue
    }
    if (!arg.startsWith(`-`)) {
      parsed.baseUrl = arg
    }
    i++
  }
  return parsed
}

function validateArgs(args: ParsedArgs): string | null {
  if (!args.baseUrl) return `Error: Base URL is required`
  try {
    new URL(args.baseUrl)
  } catch {
    return `Error: Invalid URL "${args.baseUrl}"`
  }
  if (args.mode === `watch` && args.watchPaths.length === 0) {
    return `Error: --watch requires at least one path`
  }
  return null
}

function getRunnerPath(): string {
  const distRunner = join(__dirname, `test-runner.js`)
  const srcRunner = join(__dirname, `test-runner.ts`)
  return existsSync(distRunner) ? distRunner : srcRunner
}

function getVitestConfigPath(): string {
  const srcPath = join(__dirname, `..`, `vitest.conformance.config.ts`)
  const distPath = join(__dirname, `..`, `..`, `vitest.conformance.config.ts`)
  if (existsSync(srcPath)) return srcPath
  return distPath
}

function findVitestBinary(): string {
  const possible = [
    join(__dirname, `..`, `node_modules`, `.bin`, `vitest`),
    join(__dirname, `..`, `..`, `..`, `..`, `.bin`, `vitest`),
    join(__dirname, `..`, `..`, `..`, `node_modules`, `.bin`, `vitest`),
  ]
  for (const candidate of possible) {
    if (existsSync(candidate)) return candidate
  }
  return `vitest`
}

function spawnTestProcess(baseUrl: string): ChildProcess {
  const vitestPath = findVitestBinary()
  const runnerPath = getRunnerPath()
  return spawn(
    vitestPath,
    [
      `run`,
      `--config`,
      getVitestConfigPath(),
      runnerPath,
      `--no-coverage`,
      `--reporter=default`,
      `--passWithNoTests=false`,
    ],
    {
      stdio: `inherit`,
      env: {
        ...process.env,
        PROXY_CONFORMANCE_TEST_URL: baseUrl,
        FORCE_COLOR: `1`,
      },
      shell: true,
    }
  )
}

async function runOnce(baseUrl: string): Promise<void> {
  console.log(`Running proxy conformance tests against ${baseUrl}\n`)
  await new Promise<void>((resolve, reject) => {
    const child = spawnTestProcess(baseUrl)
    child.on(`close`, (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Tests failed with exit code ${code ?? 1}`))
      }
    })
    child.on(`error`, () => {
      reject(new Error(`Failed to execute conformance tests`))
    })
  })
}

async function runWatch(
  baseUrl: string,
  watchPaths: Array<string>
): Promise<void> {
  let running: ChildProcess | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const rerun = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (running) {
        running.kill(`SIGTERM`)
      }
      console.clear()
      console.log(`Running proxy conformance tests against ${baseUrl}\n`)
      running = spawnTestProcess(baseUrl)
      running.on(`close`, () => {
        console.log(`\nWatching for changes in: ${watchPaths.join(`, `)}\n`)
        running = null
      })
    }, 250)
  }

  const watchers = watchPaths.map((watchPath) =>
    watch(resolve(process.cwd(), watchPath), { recursive: true }, (_, file) => {
      if (!file?.includes(`node_modules`)) rerun()
    })
  )

  process.on(`SIGINT`, () => {
    watchers.forEach((watcher) => watcher.close())
    if (running) running.kill(`SIGTERM`)
    process.exit(0)
  })

  rerun()
  await new Promise(() => {})
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    process.exit(0)
  }
  const error = validateArgs(args)
  if (error) {
    console.error(error)
    process.exit(1)
  }
  if (args.mode === `watch`) {
    await runWatch(args.baseUrl, args.watchPaths)
  } else {
    await runOnce(args.baseUrl)
    process.exit(0)
  }
}

main().catch((error: unknown) => {
  console.error(
    `Fatal error: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
})

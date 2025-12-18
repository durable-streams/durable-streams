#!/usr/bin/env node

/**
 * CLI for running Durable Streams conformance tests
 *
 * Usage:
 *   npx @durable-streams/conformance-tests --run http://localhost:4473
 *   npx @durable-streams/conformance-tests --watch src http://localhost:4473
 */

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
Durable Streams Conformance Test Runner

Usage:
  npx @durable-streams/conformance-tests --run <url>
  npx @durable-streams/conformance-tests --watch <path> [path...] <url>

Options:
  --run              Run tests once and exit (for CI)
  --watch <paths>    Watch source paths and rerun tests on changes (for development)
  --help, -h         Show this help message

Arguments:
  <url>              Base URL of the Durable Streams server to test against

Examples:
  # Run tests once in CI
  npx @durable-streams/conformance-tests --run http://localhost:4473

  # Watch src directory and rerun tests on changes
  npx @durable-streams/conformance-tests --watch src http://localhost:4473

  # Watch multiple directories
  npx @durable-streams/conformance-tests --watch src lib http://localhost:4473
`)
}

function parseArgs(args: Array<string>): ParsedArgs {
  const result: ParsedArgs = {
    mode: `run`,
    watchPaths: [],
    baseUrl: ``,
    help: false,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    if (arg === `--help` || arg === `-h`) {
      result.help = true
      return result
    }

    if (arg === `--run`) {
      result.mode = `run`
      i++
      continue
    }

    if (arg === `--watch`) {
      result.mode = `watch`
      i++
      // Collect all paths until we hit another flag or the last argument (url)
      while (i < args.length - 1) {
        const next = args[i]!
        if (next.startsWith(`--`) || next.startsWith(`-`)) {
          break
        }
        result.watchPaths.push(next)
        i++
      }
      continue
    }

    // Last non-flag argument is the URL
    if (!arg.startsWith(`-`)) {
      result.baseUrl = arg
    }

    i++
  }

  return result
}

function validateArgs(args: ParsedArgs): string | null {
  if (!args.baseUrl) {
    return `Error: Base URL is required`
  }

  try {
    new URL(args.baseUrl)
  } catch {
    return `Error: Invalid URL "${args.baseUrl}"`
  }

  if (args.mode === `watch` && args.watchPaths.length === 0) {
    return `Error: --watch requires at least one path to watch`
  }

  return null
}

// Get the path to the test runner file
function getTestRunnerPath(): string {
  const runnerInDist = join(__dirname, `test-runner.js`)
  const runnerInSrc = join(__dirname, `test-runner.ts`)

  // In production (dist), use the compiled JS
  // In development (with tsx), use TS directly
  if (existsSync(runnerInDist)) {
    return runnerInDist
  }
  return runnerInSrc
}

function runTests(baseUrl: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const runnerPath = getTestRunnerPath()

    // Find vitest binary
    const vitestBin = join(__dirname, `..`, `node_modules`, `.bin`, `vitest`)
    const vitestBinAlt = join(
      __dirname,
      `..`,
      `..`,
      `..`,
      `node_modules`,
      `.bin`,
      `vitest`
    )

    let vitestPath = `vitest`
    if (existsSync(vitestBin)) {
      vitestPath = vitestBin
    } else if (existsSync(vitestBinAlt)) {
      vitestPath = vitestBinAlt
    }

    const args = [
      `run`,
      runnerPath,
      `--no-coverage`,
      `--reporter=default`,
      `--passWithNoTests=false`,
    ]

    const child = spawn(vitestPath, args, {
      stdio: `inherit`,
      env: {
        ...process.env,
        CONFORMANCE_TEST_URL: baseUrl,
        FORCE_COLOR: `1`,
      },
      shell: true,
    })

    child.on(`close`, (code) => {
      resolvePromise(code ?? 1)
    })

    child.on(`error`, (err) => {
      console.error(`Failed to run tests: ${err.message}`)
      resolvePromise(1)
    })
  })
}

async function runOnce(baseUrl: string): Promise<void> {
  console.log(`Running conformance tests against ${baseUrl}\n`)
  const exitCode = await runTests(baseUrl)
  process.exit(exitCode)
}

async function runWatch(
  baseUrl: string,
  watchPaths: Array<string>
): Promise<void> {
  let runningProcess: ChildProcess | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const DEBOUNCE_MS = 300

  const spawnTests = (): ChildProcess => {
    const runnerPath = getTestRunnerPath()

    // Find vitest binary
    const vitestBin = join(__dirname, `..`, `node_modules`, `.bin`, `vitest`)
    const vitestBinAlt = join(
      __dirname,
      `..`,
      `..`,
      `..`,
      `node_modules`,
      `.bin`,
      `vitest`
    )

    let vitestPath = `vitest`
    if (existsSync(vitestBin)) {
      vitestPath = vitestBin
    } else if (existsSync(vitestBinAlt)) {
      vitestPath = vitestBinAlt
    }

    const args = [
      `run`,
      runnerPath,
      `--no-coverage`,
      `--reporter=default`,
      `--passWithNoTests=false`,
    ]

    return spawn(vitestPath, args, {
      stdio: `inherit`,
      env: {
        ...process.env,
        CONFORMANCE_TEST_URL: baseUrl,
        FORCE_COLOR: `1`,
      },
      shell: true,
    })
  }

  const runTestsDebounced = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    debounceTimer = setTimeout(() => {
      // Kill any running test process
      if (runningProcess) {
        runningProcess.kill(`SIGTERM`)
        runningProcess = null
      }

      console.clear()
      console.log(`Running conformance tests against ${baseUrl}\n`)

      runningProcess = spawnTests()

      runningProcess.on(`close`, (code) => {
        if (code === 0) {
          console.log(`\nAll tests passed`)
        } else {
          console.log(`\nTests failed (exit code: ${code})`)
        }
        console.log(`\nWatching for changes in: ${watchPaths.join(`, `)}`)
        console.log(`Press Ctrl+C to exit\n`)
        runningProcess = null
      })
    }, DEBOUNCE_MS)
  }

  // Set up file watchers
  const watchers: Array<ReturnType<typeof watch>> = []

  for (const watchPath of watchPaths) {
    const absPath = resolve(process.cwd(), watchPath)

    try {
      const watcher = watch(
        absPath,
        { recursive: true },
        (eventType, filename) => {
          if (filename && !filename.includes(`node_modules`)) {
            console.log(`\nChange detected: ${filename}`)
            runTestsDebounced()
          }
        }
      )

      watchers.push(watcher)
      console.log(`Watching: ${absPath}`)
    } catch (err) {
      console.error(
        `Warning: Could not watch "${watchPath}": ${(err as Error).message}`
      )
    }
  }

  if (watchers.length === 0) {
    console.error(`Error: No valid paths to watch`)
    process.exit(1)
  }

  // Handle cleanup
  process.on(`SIGINT`, () => {
    console.log(`\n\nStopping watch mode...`)
    watchers.forEach((w) => w.close())
    if (runningProcess) {
      runningProcess.kill(`SIGTERM`)
    }
    process.exit(0)
  })

  // Run tests initially
  runTestsDebounced()

  // Keep the process running
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
    console.error(`\nRun with --help for usage information`)
    process.exit(1)
  }

  if (args.mode === `watch`) {
    await runWatch(args.baseUrl, args.watchPaths)
  } else {
    await runOnce(args.baseUrl)
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`)
  process.exit(1)
})

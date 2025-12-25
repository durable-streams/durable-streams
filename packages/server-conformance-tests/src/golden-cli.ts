#!/usr/bin/env node

/**
 * CLI for golden/wire transcript testing.
 *
 * Usage:
 *   # Verify transcripts against a server
 *   npx @durable-streams/server-conformance-tests golden verify http://localhost:4473 transcripts/*.json
 *
 *   # Capture a new transcript
 *   npx @durable-streams/server-conformance-tests golden capture http://localhost:4473
 */

import { readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  captureExchange,
  formatResult,
  parseTranscripts,
  serializeTranscripts,
  verifyTranscripts,
} from "./golden.js"
import type { GoldenTranscript, TranscriptFile } from "./golden.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ParsedArgs {
  command: `verify` | `capture` | `help`
  serverUrl: string
  transcriptFiles: Array<string>
  tags?: Array<string>
  categories?: Array<GoldenTranscript[`category`]>
  failFast: boolean
  output?: string
  verbose: boolean
}

function printUsage(): void {
  console.log(`
Golden Transcript Test Runner

Commands:
  verify <url> <files...>  Verify transcripts against a server
  capture <url>            Capture new transcripts interactively
  help                     Show this help message

Options:
  --tags <tags>       Only run transcripts with these tags (comma-separated)
  --categories <cats> Only run these categories (comma-separated)
  --fail-fast         Stop on first failure
  --output <file>     Output file for captured transcripts
  --verbose           Show detailed output

Examples:
  # Verify all transcripts
  golden verify http://localhost:4473 transcripts/*.json

  # Verify only error cases
  golden verify http://localhost:4473 transcripts/*.json --tags error

  # Capture new transcripts
  golden capture http://localhost:4473 --output my-transcripts.json
`)
}

function parseArgs(args: Array<string>): ParsedArgs {
  const result: ParsedArgs = {
    command: `help`,
    serverUrl: ``,
    transcriptFiles: [],
    failFast: false,
    verbose: false,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    if (arg === `help` || arg === `--help` || arg === `-h`) {
      result.command = `help`
      return result
    }

    if (arg === `verify`) {
      result.command = `verify`
      i++
      continue
    }

    if (arg === `capture`) {
      result.command = `capture`
      i++
      continue
    }

    if (arg === `--tags` && args[i + 1]) {
      result.tags = args[i + 1]!.split(`,`)
      i += 2
      continue
    }

    if (arg === `--categories` && args[i + 1]) {
      result.categories = args[i + 1]!.split(`,`) as Array<
        GoldenTranscript[`category`]
      >
      i += 2
      continue
    }

    if (arg === `--fail-fast`) {
      result.failFast = true
      i++
      continue
    }

    if (arg === `--output` && args[i + 1]) {
      result.output = args[i + 1]!
      i += 2
      continue
    }

    if (arg === `--verbose` || arg === `-v`) {
      result.verbose = true
      i++
      continue
    }

    // Positional arguments
    if (!arg.startsWith(`-`)) {
      if (!result.serverUrl) {
        result.serverUrl = arg
      } else {
        result.transcriptFiles.push(arg)
      }
    }

    i++
  }

  return result
}

async function loadTranscriptFile(
  filePath: string
): Promise<Array<GoldenTranscript>> {
  const content = await readFile(filePath, `utf8`)
  const file = parseTranscripts(content)
  return file.transcripts
}

async function runVerify(args: ParsedArgs): Promise<void> {
  if (!args.serverUrl) {
    console.error(`Error: Server URL is required`)
    process.exit(1)
  }

  if (args.transcriptFiles.length === 0) {
    // Load bundled transcripts
    const bundledDir = resolve(__dirname, `..`, `transcripts`)
    args.transcriptFiles = [
      resolve(bundledDir, `core-operations.json`),
      resolve(bundledDir, `error-cases.json`),
    ]
    console.log(`Using bundled transcripts from ${bundledDir}`)
  }

  console.log(`\nVerifying golden transcripts against ${args.serverUrl}\n`)

  let totalPassed = 0
  let totalFailed = 0
  let totalSkipped = 0

  for (const filePath of args.transcriptFiles) {
    console.log(`\nLoading ${basename(filePath)}...`)

    try {
      const transcripts = await loadTranscriptFile(filePath)
      const summary = await verifyTranscripts(args.serverUrl, transcripts, {
        failFast: args.failFast,
        tags: args.tags,
        categories: args.categories,
      })

      for (const result of summary.results) {
        if (args.verbose || !result.passed) {
          console.log(formatResult(result))
        } else {
          // In this branch, result.passed is always true
          process.stdout.write(`.`)
        }
      }

      if (!args.verbose) {
        console.log() // newline after dots
      }

      totalPassed += summary.passed
      totalFailed += summary.failed
      totalSkipped += summary.skipped

      console.log(
        `  ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`
      )

      if (args.failFast && summary.failed > 0) {
        break
      }
    } catch (err) {
      console.error(`  Error loading file: ${(err as Error).message}`)
      totalFailed++
    }
  }

  console.log(`\n${`=`.repeat(50)}`)
  console.log(
    `Total: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`
  )

  if (totalFailed > 0) {
    process.exit(1)
  }
}

async function runCapture(args: ParsedArgs): Promise<void> {
  if (!args.serverUrl) {
    console.error(`Error: Server URL is required`)
    process.exit(1)
  }

  console.log(`\nInteractive transcript capture`)
  console.log(`Server: ${args.serverUrl}`)
  console.log(
    `\nThis will capture HTTP exchanges and save them as golden transcripts.`
  )

  // Example captures for common operations
  const transcripts: Array<GoldenTranscript> = []

  // Capture create stream
  console.log(`\nCapturing: Create text/plain stream...`)
  const createTranscript = await captureExchange(
    args.serverUrl,
    {
      method: `PUT`,
      path: `/v1/streams/golden-test-${Date.now()}`,
      headers: { "content-type": `text/plain` },
    },
    {
      id: `captured-create-${Date.now()}`,
      description: `Create a new text/plain stream`,
      category: `create`,
      tags: [`captured`],
    }
  )
  transcripts.push(createTranscript)
  console.log(`  Status: ${createTranscript.response.status}`)

  // Capture append
  console.log(`\nCapturing: Append data...`)
  const appendTranscript = await captureExchange(
    args.serverUrl,
    {
      method: `POST`,
      path: createTranscript.request.path,
      headers: { "content-type": `text/plain` },
      body: `Hello from golden capture!`,
    },
    {
      id: `captured-append-${Date.now()}`,
      description: `Append text data to stream`,
      category: `append`,
      tags: [`captured`],
    }
  )
  transcripts.push(appendTranscript)
  console.log(`  Status: ${appendTranscript.response.status}`)

  // Capture read
  console.log(`\nCapturing: Read stream...`)
  const readTranscript = await captureExchange(
    args.serverUrl,
    {
      method: `GET`,
      path: `${createTranscript.request.path}?offset=-1`,
    },
    {
      id: `captured-read-${Date.now()}`,
      description: `Read all data from stream`,
      category: `read`,
      tags: [`captured`],
    }
  )
  transcripts.push(readTranscript)
  console.log(`  Status: ${readTranscript.response.status}`)
  console.log(`  Body: ${readTranscript.response.body.slice(0, 100)}`)

  // Save transcripts
  const file: TranscriptFile = {
    meta: {
      name: `Captured Transcripts`,
      description: `Transcripts captured from ${args.serverUrl}`,
      protocolVersion: `1.0`,
    },
    transcripts,
  }

  const outputPath = args.output || `captured-transcripts-${Date.now()}.json`
  await writeFile(outputPath, serializeTranscripts(file))
  console.log(`\nSaved ${transcripts.length} transcripts to ${outputPath}`)

  // Cleanup - delete the test stream
  console.log(`\nCleaning up test stream...`)
  await fetch(new URL(createTranscript.request.path, args.serverUrl), {
    method: `DELETE`,
  })
  console.log(`Done.`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case `help`:
      printUsage()
      break
    case `verify`:
      await runVerify(args)
      break
    case `capture`:
      await runCapture(args)
      break
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${(err as Error).message}`)
  process.exit(1)
})

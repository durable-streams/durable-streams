#!/usr/bin/env node
/**
 * CLI for running client conformance tests.
 *
 * Usage:
 *   npx @durable-streams/client-conformance-tests --run ts
 *   npx @durable-streams/client-conformance-tests --run ./my-python-client
 *   npx @durable-streams/client-conformance-tests --run ./client --suite producer
 */

import { runConformanceTests } from "./runner.js"
import type { RunnerOptions } from "./runner.js"

const HELP = `
Durable Streams Client Conformance Test Suite

Usage:
  npx @durable-streams/client-conformance-tests --run <adapter> [options]

Arguments:
  <adapter>           Path to client adapter executable, or "ts" for built-in TypeScript adapter

Options:
  --suite <name>      Run only specific suite(s): producer, consumer, lifecycle
                      Can be specified multiple times
  --tag <name>        Run only tests with specific tag(s)
                      Can be specified multiple times
  --verbose           Show detailed output for each operation
  --fail-fast         Stop on first test failure
  --timeout <ms>      Timeout for each test in milliseconds (default: 30000)
  --port <port>       Port for reference server (default: random)
  --help, -h          Show this help message

Examples:
  # Test the TypeScript client
  npx @durable-streams/client-conformance-tests --run ts

  # Test a Python client adapter
  npx @durable-streams/client-conformance-tests --run ./adapters/python_adapter.py

  # Test only producer functionality
  npx @durable-streams/client-conformance-tests --run ts --suite producer

  # Test with verbose output and stop on first failure
  npx @durable-streams/client-conformance-tests --run ts --verbose --fail-fast

  # Run only core tests
  npx @durable-streams/client-conformance-tests --run ts --tag core

Implementing a Client Adapter:
  A client adapter is an executable that communicates via stdin/stdout using
  JSON-line protocol. See the documentation for the protocol specification
  and examples in different languages.

  The adapter receives JSON commands on stdin (one per line) and responds
  with JSON results on stdout (one per line).

  Commands: init, create, connect, append, read, head, delete, shutdown

  Example flow:
    Runner -> Client: {"type":"init","serverUrl":"http://localhost:3000"}
    Client -> Runner: {"type":"init","success":true,"clientName":"my-client","clientVersion":"1.0.0"}
    Runner -> Client: {"type":"create","path":"/test-stream"}
    Client -> Runner: {"type":"create","success":true,"status":201}
    ...
`

function parseArgs(args: Array<string>): RunnerOptions | null {
  const options: RunnerOptions = {
    clientAdapter: ``,
    suites: [],
    tags: [],
    verbose: false,
    failFast: false,
    testTimeout: 30000,
    serverPort: 0,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    if (arg === `--help` || arg === `-h`) {
      console.log(HELP)
      process.exit(0)
    }

    if (arg === `--run`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --run requires an adapter path`)
        return null
      }
      options.clientAdapter = args[i]!
    } else if (arg === `--suite`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --suite requires a suite name`)
        return null
      }
      const suite = args[i] as `producer` | `consumer` | `lifecycle`
      if (![`producer`, `consumer`, `lifecycle`].includes(suite)) {
        console.error(
          `Error: Invalid suite "${suite}". Must be: producer, consumer, lifecycle`
        )
        return null
      }
      options.suites!.push(suite)
    } else if (arg === `--tag`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --tag requires a tag name`)
        return null
      }
      options.tags!.push(args[i]!)
    } else if (arg === `--verbose`) {
      options.verbose = true
    } else if (arg === `--fail-fast`) {
      options.failFast = true
    } else if (arg === `--timeout`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --timeout requires a value in milliseconds`)
        return null
      }
      options.testTimeout = parseInt(args[i]!, 10)
      if (isNaN(options.testTimeout)) {
        console.error(`Error: --timeout must be a number`)
        return null
      }
    } else if (arg === `--port`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --port requires a port number`)
        return null
      }
      options.serverPort = parseInt(args[i]!, 10)
      if (isNaN(options.serverPort)) {
        console.error(`Error: --port must be a number`)
        return null
      }
    } else if (arg.startsWith(`-`)) {
      console.error(`Error: Unknown option "${arg}"`)
      return null
    }

    i++
  }

  // Validate required options
  if (!options.clientAdapter) {
    console.error(`Error: --run <adapter> is required`)
    console.log(`\nRun with --help for usage information`)
    return null
  }

  // Clean up empty arrays
  if (options.suites!.length === 0) {
    delete options.suites
  }
  if (options.tags!.length === 0) {
    delete options.tags
  }

  return options
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log(HELP)
    process.exit(0)
  }

  const options = parseArgs(args)
  if (!options) {
    process.exit(1)
  }

  try {
    const summary = await runConformanceTests(options)

    if (summary.failed > 0) {
      process.exit(1)
    }
  } catch (err) {
    console.error(`Error running conformance tests:`, err)
    process.exit(1)
  }
}

main()

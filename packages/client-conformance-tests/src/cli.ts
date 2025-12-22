#!/usr/bin/env node
/**
 * CLI for running client conformance tests and benchmarks.
 *
 * Usage:
 *   npx @durable-streams/client-conformance-tests --run ts
 *   npx @durable-streams/client-conformance-tests --run ./my-python-client
 *   npx @durable-streams/client-conformance-tests --run ./client --suite producer
 *   npx @durable-streams/client-conformance-tests --bench ts
 */

import { runConformanceTests } from "./runner.js"
import { runBenchmarks } from "./benchmark-runner.js"
import type { RunnerOptions } from "./runner.js"
import type { BenchmarkRunnerOptions } from "./benchmark-runner.js"

const HELP = `
Durable Streams Client Conformance Test Suite

Usage:
  npx @durable-streams/client-conformance-tests --run <adapter> [options]
  npx @durable-streams/client-conformance-tests --bench <adapter> [options]

Arguments:
  <adapter>           Path to client adapter executable, or "ts" for built-in TypeScript adapter

Conformance Test Options:
  --run <adapter>     Run conformance tests with the specified adapter
  --suite <name>      Run only specific suite(s): producer, consumer, lifecycle
                      Can be specified multiple times
  --tag <name>        Run only tests with specific tag(s)
                      Can be specified multiple times
  --fail-fast         Stop on first test failure
  --timeout <ms>      Timeout for each test in milliseconds (default: 30000)

Benchmark Options:
  --bench <adapter>   Run benchmarks with the specified adapter
  --scenario <id>     Run only specific scenario(s) by ID
                      Can be specified multiple times
  --category <name>   Run only scenarios in category: latency, throughput, streaming
                      Can be specified multiple times
  --format <fmt>      Output format: console, json, markdown (default: console)

Common Options:
  --verbose           Show detailed output for each operation
  --port <port>       Port for reference server (default: random)
  --help, -h          Show this help message

Conformance Test Examples:
  # Test the TypeScript client
  npx @durable-streams/client-conformance-tests --run ts

  # Test a Python client adapter
  npx @durable-streams/client-conformance-tests --run ./adapters/python_adapter.py

  # Test only producer functionality
  npx @durable-streams/client-conformance-tests --run ts --suite producer

  # Test with verbose output and stop on first failure
  npx @durable-streams/client-conformance-tests --run ts --verbose --fail-fast

Benchmark Examples:
  # Run all benchmarks with TypeScript client
  npx @durable-streams/client-conformance-tests --bench ts

  # Run only latency benchmarks
  npx @durable-streams/client-conformance-tests --bench ts --category latency

  # Run specific scenario
  npx @durable-streams/client-conformance-tests --bench ts --scenario latency-append

  # Output as JSON for CI
  npx @durable-streams/client-conformance-tests --bench ts --format json

Implementing a Client Adapter:
  A client adapter is an executable that communicates via stdin/stdout using
  JSON-line protocol. See the documentation for the protocol specification
  and examples in different languages.

  The adapter receives JSON commands on stdin (one per line) and responds
  with JSON results on stdout (one per line).

  Commands: init, create, connect, append, read, head, delete, shutdown, benchmark

  Example flow:
    Runner -> Client: {"type":"init","serverUrl":"http://localhost:3000"}
    Client -> Runner: {"type":"init","success":true,"clientName":"my-client","clientVersion":"1.0.0"}
    Runner -> Client: {"type":"create","path":"/test-stream"}
    Client -> Runner: {"type":"create","success":true,"status":201}
    ...
`

type ParsedOptions =
  | { mode: `conformance`; options: RunnerOptions }
  | { mode: `benchmark`; options: BenchmarkRunnerOptions }
  | null

function parseArgs(args: Array<string>): ParsedOptions {
  let mode: `conformance` | `benchmark` | null = null
  let clientAdapter = ``

  // Conformance-specific options
  const suites: Array<`producer` | `consumer` | `lifecycle`> = []
  const tags: Array<string> = []
  let failFast = false
  let testTimeout = 30000

  // Benchmark-specific options
  const scenarios: Array<string> = []
  const categories: Array<`latency` | `throughput` | `streaming`> = []
  let format: `console` | `json` | `markdown` = `console`

  // Common options
  let verbose = false
  let serverPort = 0

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    if (arg === `--help` || arg === `-h`) {
      console.log(HELP)
      process.exit(0)
    }

    if (arg === `--run`) {
      mode = `conformance`
      i++
      if (i >= args.length) {
        console.error(`Error: --run requires an adapter path`)
        return null
      }
      clientAdapter = args[i]!
    } else if (arg === `--bench`) {
      mode = `benchmark`
      i++
      if (i >= args.length) {
        console.error(`Error: --bench requires an adapter path`)
        return null
      }
      clientAdapter = args[i]!
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
      suites.push(suite)
    } else if (arg === `--tag`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --tag requires a tag name`)
        return null
      }
      tags.push(args[i]!)
    } else if (arg === `--scenario`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --scenario requires a scenario ID`)
        return null
      }
      scenarios.push(args[i]!)
    } else if (arg === `--category`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --category requires a category name`)
        return null
      }
      const category = args[i] as `latency` | `throughput` | `streaming`
      if (![`latency`, `throughput`, `streaming`].includes(category)) {
        console.error(
          `Error: Invalid category "${category}". Must be: latency, throughput, streaming`
        )
        return null
      }
      categories.push(category)
    } else if (arg === `--format`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --format requires a format name`)
        return null
      }
      const fmt = args[i] as `console` | `json` | `markdown`
      if (![`console`, `json`, `markdown`].includes(fmt)) {
        console.error(
          `Error: Invalid format "${fmt}". Must be: console, json, markdown`
        )
        return null
      }
      format = fmt
    } else if (arg === `--verbose`) {
      verbose = true
    } else if (arg === `--fail-fast`) {
      failFast = true
    } else if (arg === `--timeout`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --timeout requires a value in milliseconds`)
        return null
      }
      testTimeout = parseInt(args[i]!, 10)
      if (isNaN(testTimeout)) {
        console.error(`Error: --timeout must be a number`)
        return null
      }
    } else if (arg === `--port`) {
      i++
      if (i >= args.length) {
        console.error(`Error: --port requires a port number`)
        return null
      }
      serverPort = parseInt(args[i]!, 10)
      if (isNaN(serverPort)) {
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
  if (!mode || !clientAdapter) {
    console.error(`Error: --run <adapter> or --bench <adapter> is required`)
    console.log(`\nRun with --help for usage information`)
    return null
  }

  if (mode === `conformance`) {
    const options: RunnerOptions = {
      clientAdapter,
      verbose,
      failFast,
      testTimeout,
      serverPort,
    }
    if (suites.length > 0) options.suites = suites
    if (tags.length > 0) options.tags = tags
    return { mode: `conformance`, options }
  } else {
    const options: BenchmarkRunnerOptions = {
      clientAdapter,
      verbose,
      serverPort,
      format,
    }
    if (scenarios.length > 0) options.scenarios = scenarios
    if (categories.length > 0) options.categories = categories
    return { mode: `benchmark`, options }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log(HELP)
    process.exit(0)
  }

  const parsed = parseArgs(args)
  if (!parsed) {
    process.exit(1)
  }

  try {
    if (parsed.mode === `conformance`) {
      const summary = await runConformanceTests(parsed.options)
      if (summary.failed > 0) {
        process.exit(1)
      }
    } else {
      const summary = await runBenchmarks(parsed.options)
      if (summary.failed > 0) {
        process.exit(1)
      }
    }
  } catch (err) {
    console.error(`Error running ${parsed.mode}:`, err)
    process.exit(1)
  }
}

main()

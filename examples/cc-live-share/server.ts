#!/usr/bin/env npx tsx

/**
 * Start a DS dev server with CC checkpoint rules configured.
 *
 * Usage:
 *   npx tsx server.ts [--port 4437] [--data-dir ./data]
 */

import { DurableStreamTestServer } from "@durable-streams/server"

const args = process.argv.slice(2)
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback
}

const port = parseInt(getArg(`--port`, `4437`), 10)
const dataDir = args.includes(`--data-dir`)
  ? getArg(`--data-dir`, `./data`)
  : undefined

const server = new DurableStreamTestServer({
  port,
  dataDir,
  checkpointRules: [
    {
      name: `compact`,
      conditions: [
        { path: `.type`, value: `system` },
        { path: `.subtype`, value: `compact_boundary` },
      ],
    },
  ],
})

await server.start()
console.log(`DS server running at ${server.url}`)
console.log(
  `  Checkpoint rules: compact (type=system, subtype=compact_boundary)`
)
if (dataDir) console.log(`  Data dir: ${dataDir}`)
else console.log(`  Storage: in-memory`)
console.log(`\nPress Ctrl+C to stop.\n`)

process.on(`SIGINT`, async () => {
  console.log(`\nShutting down...`)
  await server.stop()
  process.exit(0)
})

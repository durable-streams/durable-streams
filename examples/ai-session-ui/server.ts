/**
 * Durable Streams server for AI Session
 *
 * Run with: npx tsx server.ts
 */

import { DurableStreamTestServer } from "@durable-streams/server"

const PORT = 4000

async function main() {
  const server = new DurableStreamTestServer({ port: PORT })
  await server.start()
  console.log(`Durable Streams server running at ${server.url}`)
  console.log(`\nTo start agents, run in separate terminals:`)
  console.log(`  ANTHROPIC_API_KEY=your-key npx tsx agent-runner.ts filesystem ${server.url}/sessions/your-session-id`)
  console.log(`  ANTHROPIC_API_KEY=your-key npx tsx agent-runner.ts api ${server.url}/sessions/your-session-id`)

  // Keep the process alive
  await new Promise(() => {})
}

main().catch(console.error)

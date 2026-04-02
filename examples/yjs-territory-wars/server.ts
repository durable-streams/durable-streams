import { AgentServer } from "./src/agent/agent-server"

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing environment variable: ${name}`)
    process.exit(1)
  }
  return value
}

const yjsBaseUrl = required(`VITE_YJS_URL`)
const yjsToken = required(`VITE_YJS_TOKEN`)
const dsUrl = required(`VITE_DS_URL`)
const dsToken = required(`VITE_DS_TOKEN`)
const anthropicApiKey = required(`ANTHROPIC_API_KEY`)

const server = new AgentServer({
  yjsBaseUrl,
  yjsHeaders: { Authorization: `Bearer ${yjsToken}` },
  dsUrl,
  dsHeaders: { Authorization: `Bearer ${dsToken}` },
  anthropicApiKey,
})

server.start().catch((err) => {
  console.error(`[AgentServer] Failed to start:`, err)
  process.exit(1)
})

// Graceful shutdown
process.on(`SIGINT`, () => {
  console.log(`\n[AgentServer] Shutting down...`)
  server.stop()
  process.exit(0)
})
process.on(`SIGTERM`, () => {
  server.stop()
  process.exit(0)
})

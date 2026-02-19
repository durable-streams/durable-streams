import { afterAll } from "vitest"
import {
  startTestServers,
  stopTestServers,
} from "../tests/harness/server-orchestrator.js"
import { runProxyConformanceTests } from "./index.js"
import type { TestServers } from "../tests/harness/server-orchestrator.js"

const config = {
  baseUrl: ``,
  capabilities: { closedAppendConflict: true },
  adapter: {
    closeStream: async (streamId: string) => {
      const url = new URL(
        `/v1/streams/${encodeURIComponent(streamId)}`,
        servers.urls.durableStreams
      )
      const response = await fetch(url.toString(), {
        method: `POST`,
        headers: {
          "Content-Type": `application/octet-stream`,
          "Stream-Closed": `true`,
        },
      })
      if (!response.ok && response.status !== 204) {
        throw new Error(
          `Failed to close durable stream ${streamId}: ${response.status}`
        )
      }
    },
  },
}
const servers: TestServers = await startTestServers()
config.baseUrl = servers.urls.proxy

afterAll(async () => {
  await stopTestServers(servers)
})

runProxyConformanceTests(config)

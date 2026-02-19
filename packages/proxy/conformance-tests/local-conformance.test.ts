import { afterAll } from "vitest"
import {
  startTestServers,
  stopTestServers,
} from "../tests/harness/server-orchestrator.js"
import { runProxyConformanceTests } from "./index.js"
import type { TestServers } from "../tests/harness/server-orchestrator.js"

const config = { baseUrl: `` }
const servers: TestServers = await startTestServers()
config.baseUrl = servers.urls.proxy

afterAll(async () => {
  await stopTestServers(servers)
})

runProxyConformanceTests(config)

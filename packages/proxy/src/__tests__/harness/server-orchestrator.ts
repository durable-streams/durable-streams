/**
 * Server orchestrator for proxy tests.
 *
 * Manages the lifecycle of all servers needed for testing:
 * - Mock upstream server (simulates OpenAI, Anthropic, etc.)
 * - Durable streams reference server (stores stream data)
 * - Proxy server (the system under test)
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { createProxyServer } from "../../server"
import { createMockUpstream } from "./mock-upstream"
import type { ProxyServer } from "../../server"
import type { MockUpstreamServer } from "./mock-upstream"

/**
 * Options for the test orchestrator.
 */
export interface OrchestratorOptions {
  /** Port for mock upstream (default: 4439) */
  upstreamPort?: number
  /** Port for durable streams server (default: 4438) */
  durableStreamsPort?: number
  /** Port for proxy server (default: 4437) */
  proxyPort?: number
  /** Allowlist patterns for the proxy */
  allowlist?: Array<string>
}

/**
 * All servers managed by the orchestrator.
 */
export interface TestServers {
  /** Mock upstream server */
  upstream: MockUpstreamServer
  /** Durable streams server */
  durableStreams: DurableStreamTestServer
  /** Proxy server */
  proxy: ProxyServer
  /** URLs for all servers */
  urls: {
    upstream: string
    durableStreams: string
    proxy: string
  }
}

/**
 * Get a random port in a safe range.
 */
function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000)
}

/**
 * Create and start all test servers.
 *
 * @param options - Configuration options
 * @returns All running servers
 *
 * @example
 * ```typescript
 * const servers = await startTestServers()
 *
 * // Run tests...
 *
 * await stopTestServers(servers)
 * ```
 */
export async function startTestServers(
  options: OrchestratorOptions = {}
): Promise<TestServers> {
  // Use random ports to avoid conflicts in parallel tests
  const basePort = getRandomPort()
  const {
    upstreamPort = basePort,
    durableStreamsPort = basePort + 1,
    proxyPort = basePort + 2,
    allowlist = [
      `http://localhost:*/**`,
      `https://api.openai.com/**`,
      `https://api.anthropic.com/**`,
    ],
  } = options

  // Start mock upstream first
  const upstream = await createMockUpstream({
    port: upstreamPort,
    host: `localhost`,
  })

  // Start durable streams server
  const durableStreams = new DurableStreamTestServer({
    port: durableStreamsPort,
    host: `localhost`,
  })
  const durableStreamsUrl = await durableStreams.start()

  // Start proxy server
  const proxy = await createProxyServer({
    port: proxyPort,
    host: `localhost`,
    durableStreamsUrl,
    allowlist,
    jwtSecret: `test-secret-key-for-development`,
    streamTtlSeconds: 3600, // 1 hour for tests
  })

  return {
    upstream,
    durableStreams,
    proxy,
    urls: {
      upstream: upstream.url,
      durableStreams: durableStreamsUrl,
      proxy: proxy.url,
    },
  }
}

/**
 * Stop all test servers.
 *
 * @param servers - The servers to stop
 */
export async function stopTestServers(servers: TestServers): Promise<void> {
  // Stop in reverse order
  await servers.proxy.stop()
  await servers.durableStreams.stop()
  await servers.upstream.stop()
}

/**
 * Create a test context with automatic cleanup.
 *
 * This is a convenience function for use with test frameworks.
 *
 * @param options - Configuration options
 * @returns An object with setup and teardown functions
 *
 * @example
 * ```typescript
 * const ctx = createTestContext()
 *
 * beforeAll(async () => {
 *   await ctx.setup()
 * })
 *
 * afterAll(async () => {
 *   await ctx.teardown()
 * })
 *
 * test('my test', async () => {
 *   ctx.upstream.setResponse({ body: 'Hello' })
 *   // Make request through ctx.urls.proxy...
 * })
 * ```
 */
export function createTestContext(options: OrchestratorOptions = {}): {
  setup: () => Promise<void>
  teardown: () => Promise<void>
  servers: TestServers | null
  get upstream(): MockUpstreamServer
  get durableStreams(): DurableStreamTestServer
  get proxy(): ProxyServer
  get urls(): TestServers[`urls`]
} {
  let servers: TestServers | null = null

  return {
    async setup() {
      servers = await startTestServers(options)
    },

    async teardown() {
      if (servers) {
        await stopTestServers(servers)
        servers = null
      }
    },

    get servers() {
      return servers
    },

    get upstream() {
      if (!servers)
        throw new Error(`Test context not initialized - call setup() first`)
      return servers.upstream
    },

    get durableStreams() {
      if (!servers)
        throw new Error(`Test context not initialized - call setup() first`)
      return servers.durableStreams
    },

    get proxy() {
      if (!servers)
        throw new Error(`Test context not initialized - call setup() first`)
      return servers.proxy
    },

    get urls() {
      if (!servers)
        throw new Error(`Test context not initialized - call setup() first`)
      return servers.urls
    },
  }
}

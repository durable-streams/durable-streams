/**
 * Server orchestrator for proxy tests.
 *
 * Manages the lifecycle of all servers needed for testing:
 * - Mock upstream server (simulates OpenAI, Anthropic, etc.)
 * - Durable streams reference server (stores stream data)
 * - Proxy server (the system under test)
 *
 * Running Against External Servers:
 *
 * Set the PROXY_CONFORMANCE_URL environment variable to run tests against
 * an external proxy server instead of starting a local one.
 *
 * When using an external proxy:
 * - The mock upstream server is still started locally (tests control responses)
 * - Your external proxy must have "http://localhost:*\/**" in its allowlist
 * - Your external proxy must be configured to use a durable streams backend
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
  /** Port for mock upstream (default: random) */
  upstreamPort?: number
  /** Port for durable streams server (default: random) */
  durableStreamsPort?: number
  /** Port for proxy server (default: random, ignored if PROXY_CONFORMANCE_URL is set) */
  proxyPort?: number
  /** Allowlist patterns for the proxy (ignored if PROXY_CONFORMANCE_URL is set) */
  allowlist?: Array<string>
  /** Skip starting the proxy server (use PROXY_CONFORMANCE_URL instead) */
  useExternalProxy?: boolean
}

/**
 * All servers managed by the orchestrator.
 */
export interface TestServers {
  /** Mock upstream server */
  upstream: MockUpstreamServer
  /** Durable streams server (null if using external proxy) */
  durableStreams: DurableStreamTestServer | null
  /** Proxy server (null if using external proxy) */
  proxy: ProxyServer | null
  /** URLs for all servers */
  urls: {
    upstream: string
    durableStreams: string
    proxy: string
  }
  /** Whether using an external proxy server */
  usingExternalProxy: boolean
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
 */
export async function startTestServers(
  options: OrchestratorOptions = {}
): Promise<TestServers> {
  // Check for external proxy URL
  const externalProxyUrl = process.env.PROXY_CONFORMANCE_URL
  const useExternal = options.useExternalProxy ?? !!externalProxyUrl

  if (useExternal && !externalProxyUrl) {
    throw new Error(
      `useExternalProxy is true but PROXY_CONFORMANCE_URL environment variable is not set`
    )
  }

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

  // Start mock upstream first (always needed - tests control responses)
  const upstream = await createMockUpstream({
    port: upstreamPort,
    host: `localhost`,
  })

  if (useExternal) {
    // Using external proxy - skip starting local servers
    console.log(`Using external proxy at: ${externalProxyUrl}`)
    return {
      upstream,
      durableStreams: null,
      proxy: null,
      urls: {
        upstream: upstream.url,
        durableStreams: ``, // External proxy has its own
        proxy: externalProxyUrl!,
      },
      usingExternalProxy: true,
    }
  }

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
    usingExternalProxy: false,
  }
}

/**
 * Stop all test servers.
 *
 * @param servers - The servers to stop
 */
export async function stopTestServers(servers: TestServers): Promise<void> {
  // Stop in reverse order (skip null servers when using external proxy)
  if (servers.proxy) {
    await servers.proxy.stop()
  }
  if (servers.durableStreams) {
    await servers.durableStreams.stop()
  }
  await servers.upstream.stop()
}

/**
 * Create a test context with automatic cleanup.
 *
 * This is a convenience function for use with test frameworks.
 *
 * @param options - Configuration options
 * @returns An object with setup and teardown functions
 */
export function createTestContext(options: OrchestratorOptions = {}): {
  setup: () => Promise<void>
  teardown: () => Promise<void>
  servers: TestServers | null
  get upstream(): MockUpstreamServer
  get durableStreams(): DurableStreamTestServer | null
  get proxy(): ProxyServer | null
  get urls(): TestServers[`urls`]
  get usingExternalProxy(): boolean
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

    get usingExternalProxy() {
      if (!servers)
        throw new Error(`Test context not initialized - call setup() first`)
      return servers.usingExternalProxy
    },
  }
}

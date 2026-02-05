/**
 * Run conformance tests against the C server implementation
 */

import { afterAll, beforeAll, describe } from "vitest"
import { runConformanceTests } from "@durable-streams/server-conformance-tests"

// ============================================================================
// C Server Conformance Tests
// ============================================================================

describe(`C Server Implementation`, () => {
  // The C server should be started externally on this port
  const config = { baseUrl: `http://localhost:4438` }

  beforeAll(async () => {
    // Verify server is running
    const response = await fetch(`${config.baseUrl}/v1/stream/health-check`, {
      method: `PUT`,
      headers: { "Content-Type": `text/plain` },
      body: `test`,
    })
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(
        `C server is not running at ${config.baseUrl}. Start it with: ./durable-streams-server -p 4438`
      )
    }
    // Clean up health check stream
    await fetch(`${config.baseUrl}/v1/stream/health-check`, {
      method: `DELETE`,
    })
  })

  afterAll(async () => {
    // Nothing to clean up - server is managed externally
  })

  // Run all conformance tests
  runConformanceTests(config)
})

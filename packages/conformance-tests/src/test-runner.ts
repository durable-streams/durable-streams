/**
 * Test file that runs conformance tests against a server URL
 *
 * The server URL is passed via the CONFORMANCE_TEST_URL environment variable.
 */

import { runConformanceTests } from "./index.js"

const baseUrl = process.env.CONFORMANCE_TEST_URL

if (!baseUrl) {
  throw new Error(
    `CONFORMANCE_TEST_URL environment variable is required. ` +
      `Use the CLI: npx @durable-streams/conformance-tests --run <url>`
  )
}

// Run the conformance tests against the configured server
runConformanceTests({ baseUrl })

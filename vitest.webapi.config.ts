/**
 * Vitest configuration for running conformance tests with Web APIs only.
 *
 * This configuration is designed for non-Node.js runtimes:
 * - Bun: `bun vitest --config vitest.webapi.config.ts`
 * - Deno: Can also run with Deno's vitest compatibility
 * - Cloudflare Workers: Use @cloudflare/vitest-pool-workers
 *
 * Usage:
 *   1. Start a server: npx @durable-streams/server start --port 8080
 *   2. Run tests: CONFORMANCE_TEST_URL=http://localhost:8080 pnpm test:webapi
 *
 * The conformance tests use only Web APIs (fetch, ReadableStream, etc.)
 * and can run in any JavaScript runtime that supports them.
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { defineConfig } from "vitest/config"

// Get directory of this config file (works in Node.js, Bun, and Deno)
const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    name: `webapi`,
    include: [
      // Conformance test runner (web API only)
      `packages/server-conformance-tests/src/test-runner.webapi.ts`,
      // Client tests (web API only)
      `packages/client/test/**/*.test.ts`,
      // State tests (web API only)
      `packages/state/test/**/*.test.ts`,
    ],
    exclude: [
      `**/node_modules/**`,
      // Exclude tests that require Node.js-specific features
      `packages/server/test/file-backed.test.ts`,
      `packages/server/test/conformance.test.ts`,
      `packages/caddy-plugin/**/*.test.ts`,
    ],
    // Increase timeout for network operations
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@durable-streams/client": resolve(__dirname, `./packages/client/src`),
      "@durable-streams/server": resolve(__dirname, `./packages/server/src`),
      "@durable-streams/state": resolve(__dirname, `./packages/state/src`),
      "@durable-streams/server-conformance-tests": resolve(
        __dirname,
        `./packages/server-conformance-tests/src`
      ),
    },
  },
})

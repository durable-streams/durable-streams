/**
 * Vitest configuration for running tests that use only Web APIs.
 *
 * This config excludes Node.js-specific tests (file system, child_process, etc.)
 * and includes only tests that use standard Web APIs (fetch, ReadableStream, etc.).
 *
 * Runtimes supported:
 * - Node.js: CONFORMANCE_TEST_URL=http://localhost:8080 pnpm test:webapi
 * - Bun: CONFORMANCE_TEST_URL=http://localhost:8080 bun run test:webapi
 *
 * For Cloudflare Workers, use @cloudflare/vitest-pool-workers with defineWorkersConfig().
 * See: https://developers.cloudflare.com/workers/testing/vitest-integration/
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { defineConfig } from "vitest/config"

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    name: `webapi`,
    include: [
      // Conformance tests (web API only - requires CONFORMANCE_TEST_URL env var)
      `packages/server-conformance-tests/src/test-runner.ts`,
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
      `packages/server/test/compression.test.ts`,
      `packages/caddy-plugin/**/*.test.ts`,
    ],
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

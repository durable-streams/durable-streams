/**
 * Direct Durable Object tests (test-do/) run inside workerd via
 * vitest-pool-workers, with access to DO stubs, storage, and alarms —
 * behaviors the HTTP-level conformance suite cannot observe.
 *
 * Kept out of the root vitest config on purpose: the root
 * `server-cloudflare` project runs test/ under the Node pool.
 */
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: `./test/wrangler.jsonc` },
    }),
  ],
  test: {
    include: [`test-do/**/*.test.ts`],
  },
})

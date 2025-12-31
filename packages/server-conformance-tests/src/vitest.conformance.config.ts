import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Minimal vitest config for conformance tests.
 * This config is bundled with the package and used by the CLI to ensure
 * that local vitest configs in user projects don't interfere with the tests.
 */
export default defineConfig({
  test: {
    // Set root to the package directory so include patterns work correctly
    // when running from any working directory
    root: __dirname,
    // Include test-runner files (both .ts and .js)
    include: [`**/*test-runner*`],
    // Disable coverage by default
    coverage: {
      enabled: false,
    },
  },
})

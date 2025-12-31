import { defineConfig } from "vitest/config"

/**
 * Minimal vitest config for conformance tests.
 * This config is bundled with the package and used by the CLI to ensure
 * that local vitest configs in user projects don't interfere with the tests.
 * The CLI passes --dir to set the correct test directory.
 */
export default defineConfig({
  test: {
    // Include test-runner files (both .ts and .js)
    include: [`**/*test-runner*`],
    // Disable coverage by default
    coverage: {
      enabled: false,
    },
  },
})

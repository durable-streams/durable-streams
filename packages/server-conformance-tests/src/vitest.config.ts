/**
 * Vitest configuration for the conformance test runner.
 *
 * This config is bundled with the package and used when running via npx.
 * It ensures tests run in isolation without discovering or executing
 * the caller's tests.
 */

import { defineConfig } from "vitest/config"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Config is in src/, package root is one level up
const packageRoot = join(__dirname, "..")

export default defineConfig({
  test: {
    // Only run the test-runner file, not any tests from the caller's project
    // Include both src (development) and dist (production) locations
    include: [
      join(packageRoot, "src", "test-runner.ts"),
      join(packageRoot, "dist", "test-runner.js"),
    ],
    // Exclude everything else
    exclude: ["**/node_modules/**"],
    // Don't look for workspace configs or extend parent configs
    passWithNoTests: false,
    // Use a reasonable timeout for network tests
    testTimeout: 30000,
    hookTimeout: 30000,
    // Don't collect coverage
    coverage: {
      enabled: false,
    },
    // Use default reporter for clear output
    reporters: ["default"],
    // Disable watch mode by default (CLI handles this)
    watch: false,
  },
  // Set the root to this package's directory
  root: packageRoot,
})

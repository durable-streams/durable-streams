import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    include: ["src/test-runner.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@durable-streams/server-conformance-tests": path.resolve(
        __dirname,
        "./src"
      ),
    },
  },
})

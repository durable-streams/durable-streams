import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
  resolve: {
    alias: {
      "@durable-streams/agent-session-protocol": path.resolve(
        __dirname,
        "./src"
      ),
    },
  },
})

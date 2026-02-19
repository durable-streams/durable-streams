import path from "node:path"
import { defineConfig } from "vitest/config"
import type { ViteUserConfigExport } from "vitest/config"

const config: ViteUserConfigExport = defineConfig({
  test: {
    include: [
      `tests/client/client-suite.test.ts`,
      `tests/server/server-suite.test.ts`,
    ],
    exclude: [`**/node_modules/**`],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@durable-streams/client": path.resolve(__dirname, `../client/src`),
      "@durable-streams/server": path.resolve(__dirname, `../server/src`),
      "@durable-streams/state": path.resolve(__dirname, `../state/src`),
      "@durable-streams/proxy": path.resolve(__dirname, `./src`),
    },
  },
})

export default config

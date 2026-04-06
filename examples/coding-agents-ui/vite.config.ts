import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"

export default defineConfig({
  server: {
    port: 3004,
  },
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: `@durable-streams/coding-agents/client`,
        replacement: fileURLToPath(
          new URL(`../../packages/coding-agents/src/client.ts`, import.meta.url)
        ),
      },
      {
        find: `@durable-streams/coding-agents/normalize`,
        replacement: fileURLToPath(
          new URL(
            `../../packages/coding-agents/src/normalize/index.ts`,
            import.meta.url
          )
        ),
      },
      {
        find: `@durable-streams/coding-agents/protocol`,
        replacement: fileURLToPath(
          new URL(
            `../../packages/coding-agents/src/protocol/index.ts`,
            import.meta.url
          )
        ),
      },
      {
        find: `@durable-streams/coding-agents`,
        replacement: fileURLToPath(
          new URL(`../../packages/coding-agents/src/index.ts`, import.meta.url)
        ),
      },
    ],
  },
  plugins: [tanstackStart(), viteReact()],
})

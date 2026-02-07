import path from "node:path"
import { defineConfig } from "vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import viteTsConfigPaths from "vite-tsconfig-paths"

// Force all @tanstack/db imports to resolve to a single copy.
// Without this, @durable-streams/state (workspace) resolves to its own
// devDependency copy (0.5.22) while @tanstack/react-db uses 0.5.25,
// causing `useLiveQuery` to reject Collections created by state's copy.
const tanstackDbPath = path.resolve(
  import.meta.dirname,
  "node_modules/@tanstack/db"
)

const config = defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart(),
    viteReact(),
  ],
  resolve: {
    alias: {
      "@tanstack/db": tanstackDbPath,
    },
  },
  server: {
    port: 5173,
  },
})

export default config

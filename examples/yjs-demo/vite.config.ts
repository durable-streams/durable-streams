import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"

// Force all @tanstack/db imports to resolve to a single copy.
// Without this, @durable-streams/state (workspace) resolves to its own
// copy while @tanstack/react-db uses another, causing `useLiveQuery`
// to reject Collections created by state's copy.
const tanstackDbPath = path.resolve(
  import.meta.dirname,
  "node_modules/@tanstack/db"
)

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: {
      "@tanstack/db": tanstackDbPath,
    },
  },
  server: {
    port: 3001,
    host: `0.0.0.0`,
  },
})

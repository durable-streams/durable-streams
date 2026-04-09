import { defineConfig } from "vite"
import tsConfigPaths from "vite-tsconfig-paths"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"

export default defineConfig({
  server: {
    port: 3002,
  },
  plugins: [nitro(), tsConfigPaths(), tanstackStart(), viteReact()],
})

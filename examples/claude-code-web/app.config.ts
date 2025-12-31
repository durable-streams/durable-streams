import { defineConfig } from "@tanstack/start/config"
import viteTsConfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  vite: {
    plugins: [viteTsConfigPaths()],
  },
  server: {
    preset: "node-server",
  },
})

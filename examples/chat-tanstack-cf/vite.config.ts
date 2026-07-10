import { defineConfig } from "vite"
import tsConfigPaths from "vite-tsconfig-paths"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { cloudflare } from "@cloudflare/vite-plugin"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  server: {
    port: 3002,
  },
  plugins: [
    tsConfigPaths(),
    cloudflare({ viteEnvironment: { name: `ssr` } }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
})

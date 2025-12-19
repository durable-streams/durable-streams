import { defineConfig } from "vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  server: {
    port: 3001,
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // React's Vite plugin must come after Start's Vite plugin
    react(),
  ],
  // Force Vite to use the linked workspace packages directly
  // instead of pre-bundling them (which can cache old versions)
  optimizeDeps: {
    exclude: ["@tanstack/ai", "@tanstack/ai-openai"],
  },
  ssr: {
    // Also exclude from SSR externals to ensure fresh code is used
    noExternal: ["@tanstack/ai", "@tanstack/ai-openai"],
  },
})

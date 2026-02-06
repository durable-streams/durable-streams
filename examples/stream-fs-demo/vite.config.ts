import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: [`@tanstack/db`],
  },
  server: {
    port: 3002,
    host: `0.0.0.0`,
  },
})

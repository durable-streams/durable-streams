import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    allowedHosts: ["0b20fb16d89d.ngrok-free.app"],
  },
})

import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ["ghostty-web"],
  },
  // Handle SPA routing - serve index.html for all non-asset routes
  appType: "spa",
})

import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ``)
  const proxyPort = env.PROXY_PORT || `4000`

  return {
    plugins: [TanStackRouterVite(), react()],
    server: {
      proxy: {
        "/api/chat": {
          target: `http://localhost:${proxyPort}`,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/chat/, `/v1/proxy/chat`),
        },
      },
    },
  }
})

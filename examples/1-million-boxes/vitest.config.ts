import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: `jsdom`,
    globals: true,
    include: [`src/**/*.test.{ts,tsx}`, `tests/**/*.test.{ts,tsx}`],
    exclude: [`node_modules`, `dist`, `tests/e2e/**`],
    setupFiles: [`./tests/setup.ts`],
    coverage: {
      provider: `v8`,
      reporter: [`text`, `json`, `html`],
      exclude: [`node_modules`, `tests`, `**/*.test.{ts,tsx}`],
    },
  },
})

import { defineConfig } from "vitest/config"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))

// Prefer the built runner when present (published / normal CLI use). Fall back
// to the TypeScript source for local `tsx` development.
const runnerEntry = existsSync(join(root, `dist/test-runner.js`))
  ? `dist/test-runner.js`
  : `src/test-runner.ts`

// Isolated Vitest config for the conformance CLI.
//
// Consumer projects often ship their own vitest/vite config with include
// patterns like src/**/*.test.ts and exclude **/node_modules/**. Without an
// explicit --config, Vitest picks those up from cwd and never discovers this
// package's test-runner entry.

export default defineConfig({
  root,
  test: {
    include: [runnerEntry],
    // Clear defaults so the entry under node_modules/dist is not filtered out.
    exclude: [],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

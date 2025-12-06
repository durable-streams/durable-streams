#!/usr/bin/env node

/* eslint-disable stylistic/quotes */

/**
 * Development wrapper that uses tsx to run the TypeScript source directly.
 * This allows you to use `pnpm link --global` and see changes immediately
 * without rebuilding.
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const srcPath = join(__dirname, "..", "src", "index.ts")

// Run tsx with the source file
const child = spawn("tsx", [srcPath, ...process.argv.slice(2)], {
  stdio: "inherit",
})

child.on("exit", (code) => {
  process.exit(code ?? 0)
})

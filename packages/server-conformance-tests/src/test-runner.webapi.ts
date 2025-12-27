/**
 * Universal test file that runs conformance tests against a server URL.
 *
 * This file is designed to work across all JavaScript runtimes:
 * - Node.js: CONFORMANCE_TEST_URL=... vitest
 * - Bun: CONFORMANCE_TEST_URL=... bun vitest
 * - Deno: CONFORMANCE_TEST_URL=... deno task test
 *
 * The server URL is read from the CONFORMANCE_TEST_URL environment variable.
 */

import { runConformanceTests } from "./index.js"

// Declare types for non-Node.js globals
declare const Deno:
  | { env: { get: (key: string) => string | undefined } }
  | undefined

/**
 * Get environment variable across different runtimes.
 * Supports Node.js, Bun, Deno, and Vite's import.meta.env
 */
function getEnv(name: string): string | undefined {
  // Vite/Vitest injects env vars via import.meta.env
  const metaEnv = (import.meta as { env?: Record<string, string> }).env
  if (metaEnv?.[name]) {
    return metaEnv[name]
  }
  // Vite also uses VITE_ prefix for env vars
  if (metaEnv?.[`VITE_${name}`]) {
    return metaEnv[`VITE_${name}`]
  }

  // Node.js, Bun use process.env
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof process !== `undefined` && process.env) {
    const value = process.env[name]
    if (value) return value
  }

  // Deno uses Deno.env.get()
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof Deno !== `undefined` && Deno && Deno.env) {
    return Deno.env.get(name)
  }

  return undefined
}

const baseUrl = getEnv(`CONFORMANCE_TEST_URL`)

if (!baseUrl) {
  throw new Error(
    `Server URL is required. ` +
      `Set CONFORMANCE_TEST_URL environment variable. ` +
      `Example: CONFORMANCE_TEST_URL=http://localhost:8080 vitest --config vitest.webapi.config.ts`
  )
}

// Run the conformance tests against the configured server
runConformanceTests({ baseUrl })

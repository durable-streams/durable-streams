/**
 * Minimal typing for the `cloudflare:workers` runtime module (provided by
 * workerd via the Cloudflare Vite plugin). Only what this app uses —
 * pulling in @cloudflare/workers-types would conflict with DOM globals.
 */
declare module "cloudflare:workers" {
  export function waitUntil(promise: Promise<unknown>): void
}

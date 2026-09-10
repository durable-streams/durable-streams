/**
 * @durable-streams/server-cloudflare — a Durable Streams protocol server as a library.
 *
 * Consumers mount it in their own Worker:
 *
 * ```ts
 * export { StreamObject } from "@durable-streams/server-cloudflare";
 * export default { fetch: createStreamsHandler({ auth: ... }) };
 * ```
 *
 * See `template/` in the repo for a complete deployable Worker and the
 * required wrangler DO binding + migration.
 */
export { StreamObject } from "./stream-object"
export type { StreamsEnv } from "./stream-object"
export { createStreamsHandler } from "./handler"
export type { StreamsHandlerOptions, DefaultAuthEnv } from "./handler"

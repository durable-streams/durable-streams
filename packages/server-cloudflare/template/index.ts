/**
 * Deployable Durable Streams server — the template for mounting the
 * library in a Worker. This is exactly what a consumer's entry looks
 * like, except imports come from the `durable-object-streams` package
 * instead of `../src`.
 *
 * Auth: the default hook requires `Authorization: Bearer <AUTH_TOKEN>`
 * whenever the AUTH_TOKEN secret/var is set, and is open otherwise.
 * Pass your own `auth` function to createStreamsHandler to change that.
 */
import { createStreamsHandler } from "../src";
import type { DefaultAuthEnv } from "../src";

export { StreamObject } from "../src";

export default {
  fetch: createStreamsHandler(),
} satisfies ExportedHandler<DefaultAuthEnv>;

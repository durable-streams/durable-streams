/**
 * Dev-loop conformance harness.
 *
 * The published CLI (`npx @durable-streams/server-conformance-tests --run`)
 * is broken under vitest 4 ("No test files found" — its runner file misses
 * the include glob), so this file invokes the same exported entrypoint the
 * repo's own harness uses. Identical tests, identical counts.
 *
 * Usage: CONFORMANCE_TEST_URL=http://localhost:8787 npx vitest run conformance/conformance.test.mjs
 */
import { runConformanceTests } from "@durable-streams/server-conformance-tests";

runConformanceTests({
  baseUrl: process.env.CONFORMANCE_TEST_URL ?? "http://localhost:8787",
});

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@durable-streams/client": path.resolve(
        __dirname,
        "../client/src"
      ),
      "@durable-streams/server-conformance-tests": path.resolve(
        __dirname,
        "../server-conformance-tests/src"
      ),
    },
  },
  test: {
    include: ["conformance/**/*.test.mjs"],
    testTimeout: 30_000,
  },
});

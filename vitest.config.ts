import { defineConfig, defineProject } from "vitest/config"
import path from "node:path"

const alias = {
  "@durable-streams/client": path.resolve(__dirname, "./packages/client/src"),
  "@durable-streams/cli": path.resolve(__dirname, "./packages/cli/src"),
  "@durable-streams/server": path.resolve(__dirname, "./packages/server/src"),
  "@durable-streams/state": path.resolve(__dirname, "./packages/state/src"),
  "@durable-streams/server-conformance-tests": path.resolve(
    __dirname,
    "./packages/server-conformance-tests/src"
  ),
}

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "client",
          include: ["packages/client/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "server",
          include: ["packages/server/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "caddy",
          include: ["packages/caddy-plugin/**/*.test.ts"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "state",
          include: ["packages/state/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "cli",
          include: ["packages/cli/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
        },
        resolve: { alias },
      }),
    ],
    coverage: {
      provider: `v8`,
      reporter: [`text`, `json`, `html`],
    },
  },
})

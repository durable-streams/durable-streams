import { defineConfig, defineProject } from "vitest/config"
import path from "node:path"

const alias = {
  "@durable-streams/client": path.resolve(__dirname, "./packages/client/src"),
  "@durable-streams/server": path.resolve(__dirname, "./packages/server/src"),
  "@durable-streams/state": path.resolve(__dirname, "./packages/state/src"),
  "@durable-streams/conformance-tests": path.resolve(
    __dirname,
    "./packages/conformance-tests/src"
  ),
  "@durable-streams/yjs-demo": path.resolve(
    __dirname,
    "./packages/yjs-demo/src"
  ),
  "y-durable-streams": path.resolve(
    __dirname,
    "./packages/y-durable-streams/src"
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
          name: "state",
          include: ["packages/state/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "yjs-demo",
          include: ["packages/yjs-demo/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "y-durable-streams",
          include: ["packages/y-durable-streams/test/**/*.test.ts"],
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

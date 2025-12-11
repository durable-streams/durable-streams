import { defineConfig, defineProject } from "vitest/config"
import path from "node:path"

const alias = {
  "@durable-streams/client": path.resolve(__dirname, "./packages/client/src"),
  "@durable-streams/server": path.resolve(__dirname, "./packages/server/src"),
  "@durable-streams/writer": path.resolve(__dirname, "./packages/writer/src"),
  "@durable-streams/conformance-tests": path.resolve(
    __dirname,
    "./packages/conformance-tests/src"
  ),
}

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "client",
          include: ["packages/client/**/*.test.ts"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "server",
          include: ["packages/server/**/*.test.ts"],
        },
        resolve: { alias },
      }),
      defineProject({
        test: {
          name: "writer",
          include: ["packages/writer/**/*.test.ts"],
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

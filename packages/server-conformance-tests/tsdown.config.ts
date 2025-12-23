import { defineConfig } from "tsdown"

export default defineConfig({
  entry: [`./src/index.ts`, `./src/cli.ts`, `./src/test-runner.ts`],
  format: `esm`,
  platform: `node`,
  dts: true,
})

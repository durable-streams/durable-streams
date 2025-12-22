import { defineConfig } from "tsdown"

export default defineConfig({
  entry: [
    `./src/index.ts`,
    `./src/cli.ts`,
    `./src/protocol.ts`,
    `./src/adapters/typescript-adapter.ts`,
  ],
  format: `esm`,
  platform: `node`,
  dts: true,
})

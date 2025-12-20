import { defineConfig } from "tsdown"

export default defineConfig({
  entry: [`./src/index.ts`, `./src/client.ts`, `./src/server.ts`],
  format: `esm`,
  platform: `neutral`,
  dts: true,
})

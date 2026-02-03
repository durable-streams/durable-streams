import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/tools/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
})

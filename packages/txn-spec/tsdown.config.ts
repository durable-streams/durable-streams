import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    test: "src/test.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
})

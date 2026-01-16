import type { Options } from "tsdown"

const config: Options = {
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  dts: true,
  clean: true,
}

export default config

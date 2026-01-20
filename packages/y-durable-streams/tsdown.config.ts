import type { Options } from "tsdown"

const config: Options = {
  entry: ["src/index.ts", "src/server/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
}

export default config

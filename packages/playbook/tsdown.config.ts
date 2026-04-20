import type { Options } from "tsdown"

const config: Options = {
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
}

export default config

import type { Options } from "tsdown"

const config: Options = {
  entry: [
    "src/index.ts",
    "src/client.ts",
    "src/normalize/index.ts",
    "src/protocol/index.ts",
    "cli/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
}

export default config

import type { Options } from "tsdown"

const config: Options = {
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/protocol.ts",
    "src/adapters/typescript-adapter.ts",
  ],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
}

export default config

import type { Options } from "tsdown"

const config: Options = {
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  dts: true,
  clean: true,
  external: [/^cloudflare:/],
}

export default config

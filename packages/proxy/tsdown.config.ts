import type { Options } from "tsdown"

const config: Options = {
  entry: [
    "src/server/index.ts",
    "src/client/index.ts",
    "src/transports/index.ts",
    "conformance-tests/index.ts",
    "conformance-tests/cli.ts",
    "conformance-tests/test-runner.ts",
  ],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
}

export default config

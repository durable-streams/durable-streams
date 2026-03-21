import type { Options } from "tsdown"

const config: Options = {
  entry: [
    "src/index.ts",
    "src/handler.ts",
    "src/types.ts",
    "src/errors.ts",
    "src/constants.ts",
    "src/offsets.ts",
    "src/cursor.ts",
    "src/protocol.ts",
    "src/path.ts",
    "src/registry-hook.ts",
    "src/storage/memory.ts",
    "src/file-store.ts",
    "src/server.ts",
  ],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
}

export default config

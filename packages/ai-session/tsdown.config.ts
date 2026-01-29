import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/schema.ts", "src/adapters/vercel.ts"],
  format: ["esm"],
  dts: false, // Skip for prototype - Zod schemas don't work with isolatedDeclarations
  clean: true,
})

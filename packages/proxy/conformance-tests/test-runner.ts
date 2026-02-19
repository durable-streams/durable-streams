import { runProxyConformanceTests } from "./index.js"

const baseUrl = process.env.PROXY_CONFORMANCE_TEST_URL

if (!baseUrl) {
  throw new Error(
    `PROXY_CONFORMANCE_TEST_URL environment variable is required. ` +
      `Use the CLI: npx durable-streams-proxy-conformance --run <url>`
  )
}

runProxyConformanceTests({ baseUrl })

/**
 * OTel SDK initialization — must be imported before any instrumented code.
 * Exports traces to Honeycomb via OTLP/protobuf.
 */

import "dotenv/config"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api"

const apiKey = process.env.HONEYCOMB_API_KEY
if (!apiKey) {
  console.warn(
    `[tracing] HONEYCOMB_API_KEY not set — traces will not be exported`
  )
}
console.log({ apiKey })

if (process.env.OTEL_DEBUG) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
}

const exporter = new OTLPTraceExporter({
  url: `https://api.honeycomb.io/v1/traces`,
  headers: {
    "x-honeycomb-team": apiKey ?? ``,
  },
})

const sdk = new NodeSDK({
  traceExporter: exporter,
  serviceName: `durable-streams-webhook-agents-ui`,
})

sdk.start()

process.on(`SIGTERM`, () => sdk.shutdown())
process.on(`SIGINT`, () => sdk.shutdown())

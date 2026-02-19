import { initRuntime } from "./runtime.js"
import type { ProxyConformanceOptions } from "./runtime.js"
import "./tests/create-read.test.js"
import "./tests/abort-head-delete.test.js"
import "./tests/connect.test.js"
import "./tests/headers-allowlist-errors.test.js"
import "./tests/framing.test.js"
import "./tests/stream-reuse.test.js"
import "./tests/connect-extended.test.js"
import "./tests/allowlist-extended.test.js"
import "./tests/headers-cors.test.js"
import "./tests/abort-targeted.test.js"
import "./tests/upstream-errors-extended.test.js"
import "./tests/create-extended.test.js"
import "./tests/read-extended.test.js"
import "./tests/head-extended.test.js"
import "./tests/control-messages-extended.test.js"
import "./tests/dispatch.test.js"
import "./tests/abort-extended.test.js"
import "./tests/connect-more.test.js"
import "./tests/headers-forwarding-extended.test.js"
import "./tests/delete-extended.test.js"
import "./tests/framing-extended.test.js"
import "./tests/upstream-errors-codes.test.js"
import "./tests/renew-stream.test.js"
import "./tests/stream-closed-append.test.js"
import "./tests/pre-signed-freshness.test.js"
import "./tests/auth-service-fallback.test.js"
import "./tests/async-piping.test.js"

export type {
  ProxyConformanceAdapter,
  ProxyConformanceCapabilities,
  ProxyConformanceOptions,
} from "./runtime.js"

export function runProxyConformanceTests(
  options: ProxyConformanceOptions
): void {
  initRuntime(options)
}

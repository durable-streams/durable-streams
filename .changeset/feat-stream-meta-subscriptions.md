---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

feat(server): add reserved subscription APIs

The protocol now reserves `/v1/stream/__ds/*` for subscription control APIs.
The TypeScript server implements webhook and pull-wake subscription lifecycle,
stream membership, webhook callback ack, pull-wake claim/ack/release, and JWKS
discovery for webhook signature verification.

The server conformance package now includes opt-in coverage for the reserved
subscription APIs.

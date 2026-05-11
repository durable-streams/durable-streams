---
"@durable-streams/server": minor
"@durable-streams/server-conformance-tests": minor
---

feat(server): replace consumer/webhook drafts with stream metadata subscriptions

The protocol now uses `/v1/stream-meta/subscriptions/:id` for webhook and
pull-wake subscriptions. The TypeScript server implements the new subscription
lifecycle, stream membership, webhook callback ack, and pull-wake
claim/ack/release APIs, while removing the previous layered consumer and
standalone webhook draft routes.

The server conformance package now includes opt-in coverage for the new
subscription APIs and removes the old draft consumer/webhook/pull-wake DSLs.

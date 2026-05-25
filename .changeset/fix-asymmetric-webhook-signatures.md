---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

fix(server): sign subscription webhooks with discoverable public keys

Webhook subscriptions now use Ed25519 request signatures and expose the
server's public verification keys from the Durable Streams control namespace,
removing the need for receivers to store per-subscription shared secrets.

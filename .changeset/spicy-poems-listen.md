---
"@durable-streams/server-cloudflare": patch
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

Fix five protocol and durability bugs found in review:

- JSON SSE catch-up batches now emit ONE data event (a single flattened
  JSON array) per control event, instead of per-message data events
  sharing one control boundary (Cloudflare + reference servers).
- Fork references are now fork-edge rows with stable ids qualified by the
  source generation: acquire is insert-if-absent and release is
  delete-if-present, so RPC retries after lost responses can no longer
  double-count or double-release a reference, and a delayed release can
  no longer touch a recreated stream at the same path (Cloudflare server).
- A consumed or deleted expiry alarm no longer suppresses rearming via
  the stale in-memory arming cache (Cloudflare server).
- Non-live `GET ?offset=now` reads now refresh the sliding TTL like any
  other read (Cloudflare + reference + Caddy servers).
- The 4 MiB response budget now applies to a whole stitched fork read
  instead of resetting per fork segment (Cloudflare server).

---
"@durable-streams/server": patch
---

Add strict `Stream-Expected-Offset` compare-and-append support: when the header is present on a POST append, the append succeeds only if it equals the stream's current tail offset, checked atomically inside the per-stream append path in both the in-memory and file-backed stores. Mismatches return `409 Conflict` with the current tail echoed in `Stream-Next-Offset` and the body `Expected offset conflict`. Producer deduplication still runs first (retries of already-landed appends deduplicate to success), and `Stream-Seq` composes with the new header (either check can conflict). `Stream-Seq` 409 responses now also include `Stream-Next-Offset` so conflict losers can rebase without a HEAD round-trip.

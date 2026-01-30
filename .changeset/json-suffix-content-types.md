---
'@durable-streams/client': patch
'@durable-streams/server': patch
'@durable-streams/cli': patch
---

Support +json suffix content types (e.g., application/vnd.api+json, application/ld+json) as JSON Mode per RFC 6839. Content type matching is case-insensitive and ignores parameters like charset.

---
"@durable-streams/client": minor
---

Add HTTP/1.1 connection pool to prevent stream starvation. When many streams are long-polling over HTTP/1.1 (which limits browsers to ~6 concurrent connections per domain), overflow streams now use short-polling (250ms intervals) to ensure all streams receive updates. The pool automatically rotates slots based on activity so the most active streams get long-poll priority. Only applies to http:// URLs; https:// URLs are assumed to use HTTP/2 which handles multiplexing natively.

---
"@durable-streams/client-conformance-tests": patch
---

fix: make the stdio test protocol robust to Node 24's readline behavior

Node 24's `node:readline` splits input lines on the Unicode line separators
U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), in addition to
`\n`/`\r\n`/`\r` (Node 22 only split on the latter). The conformance harness
exchanges newline-delimited JSON between the runner and the client adapter over
stdin/stdout via `readline`, and `JSON.stringify` leaves U+2028/U+2029 raw
(they are legal inside JSON strings). When a test payload contained one of these
characters, Node 24 split a single protocol message across multiple `line`
events, desyncing the command/response stream and producing spurious failures
(status-code swaps, wrong-stream data, undefined-variable cascades) that varied
run to run.

`serializeCommand` and `serializeResult` now escape U+2028/U+2029 to their
`\uXXXX` forms — still valid JSON that parses back to the identical characters,
but no longer treated as line terminators by readline. The suite now passes on
both Node 22 and Node 24.

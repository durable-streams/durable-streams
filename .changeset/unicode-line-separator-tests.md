---
"@durable-streams/client-conformance-tests": patch
---

Add conformance tests for Unicode line separator preservation in SSE parsing. Per the HTML Living Standard, SSE parsers must only split on CRLF, LF, or CR. Other Unicode line separators (U+0085 NEL, U+2028 Line Separator, U+2029 Paragraph Separator) must be preserved as data characters.

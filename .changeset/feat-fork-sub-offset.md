---
"@durable-streams/server": patch
---

feat(server): support `Stream-Fork-Sub-Offset` for arbitrary-position forks

Adds a new optional header on fork-creation `PUT` requests that refines
the divergence point past `Stream-Fork-Offset` to a sub-position the
server has not previously minted. The integer is interpreted per the
source stream's content type:

- `application/json` — number of flattened messages to inherit past the
  anchor offset.
- All other content types — number of decoded entity body bytes to
  inherit past the anchor offset.

Sub-offset is a separate addressing dimension alongside the opaque
offset and does not violate offset opacity, uniqueness, or
strict-monotonicity (PROTOCOL.md §6). Servers materialize the resolved
prefix into the fork's segment at creation time; reads on the resulting
fork are unchanged.

See PROTOCOL.md §4.2 for full semantics. This change ships fork-only;
sub-offset support for read operations is reserved for a future
revision.

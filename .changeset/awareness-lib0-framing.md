---
'@durable-streams/y-durable-streams': patch
---

Use consistent lib0 framing for awareness updates, matching document updates. Awareness data is now length-prefixed with lib0's `writeVarUint8Array` on send and decoded with `readVarUint8Array` on receive.

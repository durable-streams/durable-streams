---
"@durable-streams/server": minor
---

Refactor server internals into three layers: Store interface, StreamManager, and HTTP server.

**Breaking changes:**
- `StreamStore` renamed to `MemoryStore`
- `FileBackedStreamStore` renamed to `FileStore`
- New `StreamManager` class handles all protocol logic
- `TestServerOptions.storage` accepts `Store` interface

**New exports:** `Store`, `StoreConfig`, `StreamInfo`, `StoredMessage`, `AppendMetadata`, `SerializableProducerState`, `ClosedByInfo`

**Migration:**
```typescript
// Before
import { StreamStore, FileBackedStreamStore } from "@durable-streams/server"

// After
import { MemoryStore, FileStore, StreamManager } from "@durable-streams/server"
import type { Store } from "@durable-streams/server"
```

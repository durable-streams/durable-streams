# Stream-FS Implementation Plan

A shared filesystem abstraction for AI agents built on durable streams.

## Overview

Stream-FS provides filesystem semantics where the stream is the source of truth. Every mutation appends an event, and reading reconstructs state by replaying history. Designed for multi-agent collaboration with conflict detection via OCC.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Metadata Stream                         │
│  { type: "file", key: "/notes.md", value: {...},           │
│    headers: { operation: "insert" } }                       │
│  { type: "directory", key: "/docs", value: {...},          │
│    headers: { operation: "insert" } }                       │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│ Content Stream: abc123  │  │ Content Stream: def456  │
│ (text file)             │  │ (binary file)           │
├─────────────────────────┤  ├─────────────────────────┤
│ INIT { content: "..." } │  │ INIT { content: <b64> } │
│ PATCH { patch: "@@..." }│  │ DELTA { delta: <b64> }  │
└─────────────────────────┘  └─────────────────────────┘
```

**Key Design Decisions:**
- Two-tier streams: metadata stream + per-file content streams
- Lazy content loading: `list()` only reads metadata stream
- Text diffs via `diff-match-patch`, binary diffs via `xdelta3-wasm`
- OCC via `If-Match` header for conflict detection
- Async-only API (no sync methods)
- Focused API for AI agents (no chmod, symlinks, xattr)

## Dependencies

```json
{
  "dependencies": {
    "diff-match-patch": "^1.0.5",
    "xdelta3-wasm": "^0.1.0"
  },
  "peerDependencies": {
    "@durable-streams/client": "workspace:*"
  },
  "devDependencies": {
    "@anthropic-ai/sdk": "^0.30.0"
  }
}
```

## Prerequisites

**OCC (Optimistic Concurrency Control)** is assumed to be available in the protocol and clients:
- `If-Match` header on append requests
- `412 Precondition Failed` response when offset doesn't match
- `AppendOptions.ifMatch` in TypeScript client
- `AppendResult.offset` returned from append

See: https://github.com/durable-streams/durable-streams/issues/32

---

## Phase 1: Core Stream-FS Implementation

### 1.1 Types and Interfaces

**File: `packages/stream-fs/src/types.ts`**

Already implemented. Key types:
- `FileMetadata`, `DirectoryMetadata` - stored in metadata stream
- `TextFileContent`, `TextFilePatch` - stored in content streams
- `BinaryFileContent`, `BinaryFileDelta` - for binary files
- `StreamFactory` - abstraction for stream creation
- Error classes: `NotFoundError`, `AlreadyExistsError`, `PatchApplicationError`, etc.

### 1.2 StreamFactory Interface

**File: `packages/stream-fs/src/types.ts`**

```typescript
export interface StreamFactory {
  getStream(id: string): DurableStream
  createStream(id: string, options?: CreateStreamOptions): Promise<DurableStream>
  deleteStream(id: string): Promise<void>
}
```

Implementations:
- `InMemoryStreamFactory` - for testing (already implemented)
- `DurableStreamFactory` - wraps real client (to implement)

### 1.3 DurableFilesystem Class

**File: `packages/stream-fs/src/durable-filesystem.ts`**

Core implementation (already scaffolded). Key changes needed:

#### Add OCC tracking:

```typescript
export class DurableFilesystem {
  // Track offsets for OCC
  private metadataOffset: string | undefined
  private contentOffsets = new Map<string, string>() // contentStreamId -> offset

  // ... existing fields ...
}
```

#### Update write methods to use OCC:

```typescript
async writeFile(path: string, newContent: string | Uint8Array): Promise<void> {
  // ... existing validation ...

  const currentOffset = this.contentOffsets.get(fileMeta.contentStreamId)

  try {
    const result = await contentStream.append(JSON.stringify(patchEvent), {
      ifMatch: currentOffset
    })
    this.contentOffsets.set(fileMeta.contentStreamId, result.offset)
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      throw new PatchApplicationError(
        path,
        'concurrent modification',
        `File was modified by another agent. Call refresh() and retry.`
      )
    }
    throw err
  }

  // Update metadata with OCC too
  try {
    const metaResult = await metadataStream.append(JSON.stringify(updateEvent), {
      ifMatch: this.metadataOffset
    })
    this.metadataOffset = metaResult.offset
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      throw new PatchApplicationError(path, 'metadata conflict')
    }
    throw err
  }
}
```

#### Update read methods to track offsets:

```typescript
private async loadMetadata(): Promise<void> {
  const response = await metadataStream.stream({ live: false })
  const events = await response.json()

  // Track offset for OCC
  this.metadataOffset = response.offset

  // ... existing replay logic ...
}

private async getFileContent(contentStreamId: string): Promise<string> {
  const response = await contentStream.stream({ live: false })
  const events = await response.json()

  // Track offset for OCC
  this.contentOffsets.set(contentStreamId, response.offset)

  // ... existing replay logic ...
}
```

### 1.4 Binary File Support

**File: `packages/stream-fs/src/binary-content.ts`**

```typescript
import { create, apply } from 'xdelta3-wasm'

export async function computeBinaryDelta(
  oldContent: Uint8Array,
  newContent: Uint8Array
): Promise<Uint8Array> {
  const delta = await create(oldContent, newContent)

  // If delta is larger than 50% of new content, return null (use full replace)
  if (delta.length > newContent.length * 0.5) {
    return null
  }

  return delta
}

export async function applyBinaryDelta(
  content: Uint8Array,
  delta: Uint8Array
): Promise<Uint8Array> {
  return apply(content, delta)
}
```

Update `DurableFilesystem`:

```typescript
async writeFile(path: string, newContent: string | Uint8Array): Promise<void> {
  const fileMeta = this.files.get(normalizedPath)

  if (fileMeta.contentType === 'binary') {
    await this.writeBinaryFile(fileMeta, newContent as Uint8Array)
  } else {
    await this.writeTextFile(fileMeta, newContent as string)
  }
}

private async writeBinaryFile(
  fileMeta: FileMetadata,
  newContent: Uint8Array
): Promise<void> {
  const currentContent = await this.getBinaryFileContent(fileMeta.contentStreamId)

  const delta = await computeBinaryDelta(currentContent, newContent)

  if (delta) {
    // Append delta
    const event = {
      type: 'content',
      key: fileMeta.contentStreamId,
      value: {
        id: fileMeta.contentStreamId,
        delta: base64Encode(delta),
        checksum: await computeChecksum(newContent)
      },
      headers: { operation: 'delta' }
    }
    await contentStream.append(JSON.stringify(event), { ifMatch: currentOffset })
  } else {
    // Full replace (delta too large)
    const event = {
      type: 'content',
      key: fileMeta.contentStreamId,
      value: {
        id: fileMeta.contentStreamId,
        content: base64Encode(newContent)
      },
      headers: { operation: 'replace' }
    }
    await contentStream.append(JSON.stringify(event), { ifMatch: currentOffset })
  }
}
```

---

## Phase 2: LLM Tools

### 2.1 Tool Definitions

**File: `packages/stream-fs/src/tools/index.ts`**

Already implemented. Tools:
- `read_file`, `write_file`, `create_file`, `delete_file`
- `edit_file` (find/replace with uniqueness check)
- `list_directory`, `mkdir`, `rmdir`
- `exists`, `stat`

### 2.2 Conflict Handling in Tools

Update `handleEditFile`:

```typescript
export async function handleEditFile(
  fs: DurableFilesystem,
  params: { path: string; old_str: string; new_str: string }
): Promise<ToolResult<{ edited: true }>> {
  const { path, old_str, new_str } = params

  const maxRetries = 3
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Read current content
      const current = await fs.readTextFile(path)

      // Validate uniqueness
      const occurrences = current.split(old_str).length - 1
      if (occurrences === 0) {
        return { success: false, error: 'String not found', errorType: 'not_found' }
      }
      if (occurrences > 1) {
        return { success: false, error: `String appears ${occurrences} times`, errorType: 'ambiguous' }
      }

      // Apply edit
      const newContent = current.replace(old_str, new_str)
      await fs.writeFile(path, newContent)

      return { success: true, result: { edited: true } }
    } catch (err) {
      if (err instanceof PatchApplicationError && err.reason === 'concurrent modification') {
        // Refresh and retry
        await fs.refresh()
        continue
      }
      return formatError(err)
    }
  }

  return {
    success: false,
    error: 'Failed after 3 retries due to concurrent modifications',
    errorType: 'conflict'
  }
}
```

---

## Phase 3: Conformance Tests

### 3.1 Test Structure

```
packages/stream-fs/test-cases/
├── files/
│   ├── basic-operations.yaml      # create, read, write, delete
│   ├── text-patching.yaml         # diff-match-patch
│   ├── binary-patching.yaml       # xdelta3
│   └── large-files.yaml           # streaming, chunking
├── directories/
│   ├── basic-operations.yaml      # mkdir, rmdir, list
│   └── nested-directories.yaml    # deep hierarchies
├── sync/
│   ├── multi-agent.yaml           # refresh sees other changes
│   ├── conflict-detection.yaml    # OCC 412 errors
│   └── conflict-resolution.yaml   # retry logic
├── tools/
│   ├── edit-file.yaml             # uniqueness validation
│   ├── read-write.yaml            # basic tool operations
│   └── conflict-retry.yaml        # tool retry on conflict
└── edge-cases/
    ├── unicode.yaml
    ├── empty-files.yaml
    └── special-characters.yaml
```

### 3.2 Key Test Cases

**Conflict Detection:**
```yaml
- id: concurrent-write-conflict
  name: Detects concurrent write
  operations:
    - action: createFile
      path: /test.txt
      content: "initial"
    # Agent A reads
    - action: readFile
      path: /test.txt
      as: agentA
    # Agent B writes
    - action: writeFile
      path: /test.txt
      content: "agent B was here"
    # Agent A tries to write with stale view
    - action: writeFile
      path: /test.txt
      content: "agent A was here"
      expect:
        error: PatchApplicationError
        reason: "concurrent modification"
```

**Multi-Agent Sync:**
```yaml
- id: refresh-sees-changes
  name: Refresh sees other agent's changes
  operations:
    - action: createFilesystem
      as: fs1
    - action: createFilesystem
      as: fs2
    - action: createFile
      fs: fs1
      path: /shared.txt
      content: "from fs1"
    # fs2 doesn't see it yet
    - action: exists
      fs: fs2
      path: /shared.txt
      expect: false
    # After refresh, fs2 sees it
    - action: refresh
      fs: fs2
    - action: exists
      fs: fs2
      path: /shared.txt
      expect: true
```

---

## Phase 4: Python Client

### 4.1 Structure

```
packages/stream-fs-py/
├── pyproject.toml
├── src/
│   └── stream_fs/
│       ├── __init__.py
│       ├── filesystem.py      # DurableFilesystem
│       ├── types.py           # Type definitions
│       ├── errors.py          # Error classes
│       ├── tools.py           # LLM tool handlers
│       └── in_memory.py       # InMemoryStreamFactory
└── tests/
    └── ...
```

### 4.2 Key Implementation

**File: `src/stream_fs/filesystem.py`**

```python
from diff_match_patch import diff_match_patch
from durable_streams import DurableStream

class DurableFilesystem:
    def __init__(self, stream_factory: StreamFactory, metadata_stream_id: str = "__metadata__"):
        self._factory = stream_factory
        self._metadata_stream_id = metadata_stream_id
        self._files: dict[str, FileMetadata] = {}
        self._directories: dict[str, DirectoryMetadata] = {}
        self._content_cache: dict[str, str] = {}
        self._content_offsets: dict[str, str] = {}
        self._metadata_offset: str | None = None
        self._dmp = diff_match_patch()
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return
        # ... same logic as TS ...

    async def write_file(self, path: str, content: str | bytes) -> None:
        # ... with OCC ...
        try:
            result = await content_stream.append(
                json.dumps(patch_event),
                if_match=current_offset
            )
            self._content_offsets[content_stream_id] = result.offset
        except PreconditionFailedError:
            raise PatchApplicationError(path, "concurrent modification")
```

---

## Phase 5: Example Application

### 5.1 Claude Agent Example

**File: `examples/stream-fs-agent/src/index.ts`**

Already scaffolded. Key features:
- Initialize filesystem with production streams
- Register tools with Claude
- Handle tool calls with retry logic
- Demonstrate multi-turn conversation with file operations

### 5.2 Multi-Agent Demo

**File: `examples/multi-agent-collab/src/index.ts`**

```typescript
// Two agents collaborating on a document
const fs1 = new DurableFilesystem({ streamFactory })
const fs2 = new DurableFilesystem({ streamFactory })

await fs1.initialize()
await fs2.initialize()

// Agent 1 creates document
await fs1.createFile('/doc.md', '# Project Plan\n\n## Goals\n')

// Agent 2 refreshes and adds section
await fs2.refresh()
const content = await fs2.readTextFile('/doc.md')
await fs2.writeFile('/doc.md', content + '\n## Timeline\n')

// Agent 1 refreshes to see changes
await fs1.refresh()
console.log(await fs1.readTextFile('/doc.md'))
// Output includes both agents' contributions
```

---

## Implementation Order

1. **Week 1: Stream-FS Core with OCC**
   - Update DurableFilesystem with offset tracking
   - Integrate OCC into write methods (using `ifMatch` from client)
   - Add PreconditionFailedError handling
   - Test conflict detection
   - Add stream-fs conformance tests

2. **Week 2: Binary Support**
   - Integrate xdelta3-wasm
   - Implement binary content streams
   - Add binary conformance tests

3. **Week 3: Python Client**
   - Port DurableFilesystem to Python
   - Port tools to Python
   - Run conformance tests

4. **Week 4: Polish + Examples**
   - Multi-agent example
   - Documentation
   - Performance testing

---

## Open Questions

1. **Compaction**: How/when to compact content streams (SNAPSHOT events)?
2. **Large files**: Stream content in chunks or load all at once?
3. **Permissions**: Any access control, or fully shared?
4. **TTL**: Should files/streams have expiration?
5. **Rename/Move**: Implement as delete + create, or atomic operation?

---

## References

- Exploration branch: `claude/stream-fs-exploration-8JKnW`
- OCC PR: https://github.com/durable-streams/durable-streams/issues/32 (assumed merged)
- zen-fs (API inspiration): https://github.com/zen-fs/core
- diff-match-patch: https://github.com/google/diff-match-patch
- xdelta3: https://github.com/niclasko/xdelta3-wasm

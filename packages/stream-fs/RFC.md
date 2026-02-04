# RFC: Stream-FS - A Shared Filesystem for AI Agents

## Summary

Stream-FS provides filesystem semantics on top of durable streams. Every file operation appends events to streams, enabling multiple AI agents (and humans) to collaborate on a shared filesystem with conflict detection via optimistic concurrency control (OCC).

## Background

AI agents increasingly need to work with files—reading code, writing documentation, editing configurations. When multiple agents collaborate on the same codebase or document set, they need:

1. **Shared state**: All agents see the same filesystem
2. **Durability**: Changes persist across sessions
3. **History**: Full audit trail of who changed what
4. **Conflict detection**: Know when concurrent edits collide

Traditional filesystems don't provide these guarantees. Git provides history but requires explicit commits. Databases work but lose filesystem semantics.

Durable streams provide an append-only log primitive that naturally supports all these requirements. Stream-FS builds filesystem semantics on top.

## Problem

Building a shared, durable filesystem for AI agents requires solving several challenges:

1. **Efficient storage**: Storing full file content on every edit is wasteful
2. **Concurrent access**: Multiple agents may edit the same file simultaneously
3. **Lazy loading**: Listing directories shouldn't require loading all file contents
4. **Cross-platform**: TypeScript and Python agents need compatible implementations
5. **LLM integration**: Tools must work with Claude's function calling

## Proposal

### Architecture

Stream-FS uses a two-tier stream architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                   Metadata Stream                           │
│  Uses @durable-streams/state for CRUD operations            │
│  { type: "file", key: "/notes.md", value: {...} }          │
│  { type: "directory", key: "/docs", value: {...} }         │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│ Content Stream: abc123  │  │ Content Stream: def456  │
│ (per-file stream)       │  │ (per-file stream)       │
├─────────────────────────┤  ├─────────────────────────┤
│ { op: "init",           │  │ { op: "init",           │
│   content: "..." }      │  │   content: "..." }      │
│ { op: "patch",          │  │ { op: "patch",          │
│   patch: "@@..." }      │  │   patch: "@@..." }      │
└─────────────────────────┘  └─────────────────────────┘
```

**Metadata Stream**: Uses `@durable-streams/state` since metadata operations fit the CRUD pattern (insert file, update file, delete file). The state package handles event structure and materialization.

**Content Streams**: One stream per file, using JSON mode with newline-delimited events. Each event is a JSON object representing either initial content or a patch.

### Content Event Format

Content streams use custom JSON events (not `@durable-streams/state`) because file content doesn't fit CRUD—it's append-only patches.

```typescript
// Initial content event
{
  "op": "init",
  "content": "Hello, World!",
  "checksum": "a591a6d40bf420..."
}

// Text patch event (diff-match-patch format)
{
  "op": "patch",
  "patch": "@@ -1,13 +1,14 @@\n Hello, World\n+!\n",
  "checksum": "b94d27b9934d3e..."
}

// Full replace event (for binary or when patch is too large)
{
  "op": "replace",
  "content": "...",
  "checksum": "..."
}
```

**Checksum**: SHA-256 of content after applying the operation. Used for validation during replay.

### Text Patching

Text files use [diff-match-patch](https://github.com/google/diff-match-patch) for computing and applying patches:

- Efficient storage: Only changed portions are stored
- Robust: Handles fuzzy matching for minor context shifts
- Cross-platform: Available in TypeScript, Python, and most languages

### Binary File Handling (v1)

For v1, binary files use full replace only—no delta compression:

```typescript
// Binary file uses base64 encoding
{
  "op": "replace",
  "content": "SGVsbG8gV29ybGQh",  // base64
  "encoding": "base64",
  "checksum": "..."
}
```

Delta compression (xdelta3/Vcdiff) is deferred to v2 once we validate the core design.

### Snapshots

Snapshots are **not emitted to streams**. Instead, clients dynamically generate snapshots locally when content cache is empty and the stream has many patches:

```typescript
private async getFileContent(streamId: string): Promise<string> {
  const events = await contentStream.stream({ live: false }).json()

  // Replay all events to materialize content
  let content = ""
  for (const event of events) {
    if (event.op === "init" || event.op === "replace") {
      content = event.content
    } else if (event.op === "patch") {
      content = applyPatch(content, event.patch)
    }
  }

  // Cache locally (not in stream)
  this.contentCache.set(streamId, content)
  return content
}
```

This keeps streams clean and avoids complexity around when to snapshot.

### Conflict Detection (OCC)

Stream-FS uses optimistic concurrency control via the `If-Match` header:

1. Client reads stream, noting the current offset
2. Client computes changes locally
3. Client appends with `If-Match: <offset>`
4. Server returns `412 Precondition Failed` if offset doesn't match

**Critical design decision**: On conflict, Stream-FS **throws immediately**. It does not auto-retry.

```typescript
async writeFile(path: string, newContent: string): Promise<void> {
  const currentOffset = this.contentOffsets.get(contentStreamId)

  try {
    const result = await contentStream.append(patchEvent, {
      ifMatch: currentOffset
    })
    this.contentOffsets.set(contentStreamId, result.offset)
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      throw new PatchApplicationError(
        path,
        'concurrent modification',
        'File was modified by another agent. Call refresh() and retry.'
      )
    }
    throw err
  }
}
```

**Rationale**: Auto-retry is unsafe because the caller's `newContent` was computed from stale state. The patch made sense given what the caller saw, but may not make sense after another agent's changes. Only the caller can decide how to handle this.

### LLM Tools

Stream-FS exposes tools for Claude's function calling:

| Tool | Description |
|------|-------------|
| `read_file` | Read file content |
| `write_file` | Replace entire file content |
| `create_file` | Create a new file |
| `delete_file` | Delete a file |
| `edit_file` | Find/replace with uniqueness check |
| `list_directory` | List directory contents |
| `mkdir` | Create a directory |
| `rmdir` | Remove an empty directory |
| `exists` | Check if path exists |
| `stat` | Get file/directory metadata |

**`edit_file` uniqueness**: The `edit_file` tool requires the `old_str` to appear exactly once in the file. If it appears zero times or more than once, the tool returns an error. This prevents ambiguous edits.

**Tool conflict handling**: Tools also throw on conflict—no hidden retry magic:

```typescript
async handleEditFile(fs, params): Promise<ToolResult> {
  try {
    const current = await fs.readTextFile(path)

    // Validate uniqueness
    const occurrences = current.split(old_str).length - 1
    if (occurrences === 0) {
      return { success: false, error: 'String not found' }
    }
    if (occurrences > 1) {
      return { success: false, error: `String appears ${occurrences} times` }
    }

    // Apply edit
    const newContent = current.replace(old_str, new_str)
    await fs.writeFile(path, newContent)

    return { success: true, result: { edited: true } }
  } catch (err) {
    if (err instanceof PatchApplicationError) {
      return { success: false, error: err.message, errorType: 'conflict' }
    }
    throw err
  }
}
```

### File Deletion

When a file is deleted:

1. Delete the content stream entirely (`streamFactory.deleteStream(contentStreamId)`)
2. Append a delete event to the metadata stream

No tombstones, no soft delete. Deleting is deleting.

```typescript
async deleteFile(path: string): Promise<void> {
  const fileMeta = this.files.get(path)

  // Fully delete content stream
  await this.streamFactory.deleteStream(fileMeta.contentStreamId)

  // Remove from cache
  this.contentCache.delete(fileMeta.contentStreamId)

  // Append delete to metadata stream
  await this.metadataState.delete(path)
}
```

### Path Normalization

Paths are normalized on input:

- Always start with `/`
- No trailing slash (except root)
- No double slashes
- No `.` or `..` components

```typescript
function normalizePath(path: string): string {
  let normalized = path.startsWith("/") ? path : `/${path}`
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}
```

### Content Stream ID Generation

Content stream IDs are generated with a prefix and random suffix:

```typescript
function generateContentStreamId(): string {
  return `content_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}
```

This ensures uniqueness while making streams easily identifiable in debugging.

### API Surface

```typescript
class DurableFilesystem {
  // Lifecycle
  constructor(options: DurableFilesystemOptions)
  initialize(): Promise<void>
  close(): void

  // File operations
  createFile(path: string, content: string | Uint8Array, options?: CreateFileOptions): Promise<void>
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  readTextFile(path: string): Promise<string>
  deleteFile(path: string): Promise<void>
  applyTextPatch(path: string, patch: string): Promise<void>

  // Directory operations
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  list(path: string): Promise<Entry[]>

  // Metadata
  exists(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  stat(path: string): Promise<Stat>

  // Synchronization
  refresh(): Promise<void>

  // Cache management
  evictFromCache(path: string): void
  clearContentCache(): void
}
```

### Rename/Move Semantics

For v1, rename/move is implemented as delete + create:

```typescript
async rename(oldPath: string, newPath: string): Promise<void> {
  const content = await this.readFile(oldPath)
  const stat = await this.stat(oldPath)
  await this.createFile(newPath, content, {
    mimeType: stat.mimeType,
    contentType: stat.contentType
  })
  await this.deleteFile(oldPath)
}
```

This is not atomic but is simple and correct. Atomic rename could be added in v2 if needed.

## Definition of Success

Stream-FS v1 is successful when:

1. **Core functionality works**: Create, read, write, delete files and directories
2. **Multi-agent collaboration**: Two `DurableFilesystem` instances can share a filesystem, with `refresh()` showing each other's changes
3. **Conflict detection**: Concurrent writes to the same file throw `PatchApplicationError`
4. **LLM integration**: Claude can use the tools to manipulate files in a conversation
5. **Cross-platform**: TypeScript implementation is complete; Python implementation follows the same design

### Non-Goals for v1

- Binary delta compression (use full replace)
- Atomic rename/move
- File permissions/ACLs
- Symlinks
- TTL/expiration
- Stream compaction

## Implementation Plan

### Phase 1: Core Implementation (Current)

- [x] Types and interfaces (`types.ts`)
- [x] Schemas for validation (`schemas.ts`)
- [x] `InMemoryStreamFactory` for testing
- [x] `DurableFilesystem` class
- [ ] OCC integration (requires `If-Match` in client)
- [ ] Conformance tests

### Phase 2: LLM Tools

- [x] Tool definitions (`tools/index.ts`)
- [x] Tool handlers
- [ ] Error formatting for LLM consumption
- [ ] Example agent (`examples/stream-fs-agent`)

### Phase 3: Python Client

- [ ] `stream_fs` package structure
- [ ] `DurableFilesystem` class (port from TypeScript)
- [ ] Tool handlers
- [ ] Shared conformance tests

### Phase 4: Documentation & Examples

- [ ] README with usage examples
- [ ] Multi-agent collaboration example
- [ ] API documentation

## Open Questions

1. **Large files**: Should we chunk large files across multiple events, or load all at once?
2. **Compaction**: When content streams get long, how do we compact? (v2)
3. **Watch/subscribe**: Should we support real-time notifications of changes? (v2)

## References

- [diff-match-patch](https://github.com/google/diff-match-patch) - Text patching algorithm
- [zen-fs/core](https://github.com/zen-fs/core) - API inspiration (though architecture differs)
- [Durable Streams Protocol](../../PROTOCOL.md) - Underlying protocol
- [@durable-streams/state](../state) - State management for metadata stream

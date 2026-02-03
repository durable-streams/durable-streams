# Stream-FS Design Document

A shared filesystem abstraction for AI agents built on durable streams.

## Overview

Stream-FS provides filesystem semantics on top of durable streams. The stream is the source of truth—every mutation appends an event, and reading reconstructs state by replaying history.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Metadata Stream                         │
│  FILE_CREATED /doc.pdf (content_stream_id: abc123)         │
│  FILE_CREATED /notes.md (content_stream_id: def456)        │
│  FILE_UPDATED /notes.md (size: 1847)                       │
│  DIR_CREATED /images                                        │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────────────────────────────┐
│ Content Stream: def456 (text file)          │
├─────────────────────────────────────────────┤
│ { type: "file", key: "def456",              │
│   value: { content: "# Notes..." },         │
│   headers: { operation: "insert" } }        │
│                                             │
│ { type: "file", key: "def456",              │
│   value: { patch: "@@ -1,5 +1,10 @@..." },  │
│   headers: { operation: "patch" } }         │
└─────────────────────────────────────────────┘
```

## Built on @durable-streams/state

Stream-FS leverages the existing `state` package for materialization. This requires adding a new `patch` operation type.

### New Operation: `patch`

```typescript
// In @durable-streams/state types.ts
export type Operation = `insert` | `update` | `delete` | `upsert` | `patch`

// Patch event structure
type PatchEvent = {
  type: string
  key: string
  value: {
    patch: string      // diff-match-patch for text, xdelta3 for binary
    patchType: 'text' | 'binary'
    checksum?: string  // optional checksum for validation
  }
  headers: {
    operation: 'patch'
    txid?: string
  }
}
```

### Materialization with Patches

The `MaterializedState` class needs to handle patches:

```typescript
apply(event: ChangeEvent): void {
  switch (headers.operation) {
    case `patch`:
      const current = typeMap.get(key) as FileContent
      const patched = applyPatch(current, event.value)
      typeMap.set(key, patched)
      break
    // ... existing operations
  }
}
```

## Event Types

### Metadata Stream Events

```typescript
// Metadata collection schema
type FileMetadata = {
  path: string           // Primary key, e.g., "/docs/notes.md"
  contentStreamId: string
  contentType: 'text' | 'binary'
  mimeType?: string
  size: number
  createdAt: number
  updatedAt: number
}

type DirectoryMetadata = {
  path: string           // Primary key, e.g., "/docs"
  createdAt: number
}

// Events in metadata stream
{ type: "file", key: "/notes.md", value: {...}, headers: { operation: "insert" } }
{ type: "file", key: "/notes.md", value: {...}, headers: { operation: "update" } }
{ type: "file", key: "/notes.md", headers: { operation: "delete" } }
{ type: "directory", key: "/docs", value: {...}, headers: { operation: "insert" } }
```

### Content Stream Events

Each file has its own content stream (one stream per file):

```typescript
// Text file content
type TextFileContent = {
  id: string             // Same as contentStreamId
  content: string        // Current full content (for insert/update)
  patch?: string         // diff-match-patch (for patch operation)
  checksum?: string      // SHA-256 of content after patch
}

// Binary file content
type BinaryFileContent = {
  id: string
  content: Uint8Array    // Current full content (for insert/update)
  delta?: Uint8Array     // xdelta3 delta (for patch operation)
  checksum?: string
}
```

## API Design

### DurableFilesystem Class

```typescript
class DurableFilesystem {
  constructor(
    metadataStream: DurableStream,
    streamFactory: StreamFactory
  )

  // File Operations
  async createFile(path: string, content: string | Uint8Array, opts?: CreateFileOpts): Promise<void>
  async writeFile(path: string, content: string | Uint8Array): Promise<void>
  async readFile(path: string): Promise<Uint8Array>
  async readTextFile(path: string): Promise<string>
  async deleteFile(path: string): Promise<void>
  async applyTextPatch(path: string, patch: string): Promise<void>
  async applyBinaryDelta(path: string, delta: Uint8Array): Promise<void>

  // Directory Operations
  async mkdir(path: string): Promise<void>
  async rmdir(path: string): Promise<void>
  async list(path: string): Promise<Entry[]>

  // Metadata
  async exists(path: string): Promise<boolean>
  async isDirectory(path: string): Promise<boolean>
  async stat(path: string): Promise<Stat>

  // Synchronization
  async refresh(): Promise<void>
  watchMetadata(callback: (event: MetadataEvent) => void): () => void
  watchFile(path: string, callback: (event: ContentEvent) => void): () => void

  // Cache Management
  evictFromCache(path: string): void
  clearContentCache(): void
}
```

### StreamFactory Interface

```typescript
interface StreamFactory {
  getStream(id: string): DurableStream
  createStream(id: string, opts?: StreamOptions): Promise<DurableStream>
  deleteStream(id: string): Promise<void>
}

// In-memory implementation for testing
class InMemoryStreamFactory implements StreamFactory { ... }

// Production implementation wrapping DurableStream client
class DurableStreamFactory implements StreamFactory {
  constructor(baseUrl: string) { ... }
}
```

## Dependencies

- **diff-match-patch**: Text diffing (Google's algorithm, same as Google Docs)
- **xdelta3-wasm**: Binary diffing (efficient for localized changes)
- **@durable-streams/state**: Event materialization
- **@durable-streams/client**: Stream transport

## Conformance Tests

Stream-FS conformance tests verify:

1. **Basic file operations**: create, read, write, delete
2. **Directory operations**: mkdir, rmdir, list
3. **Text patching**: diff-match-patch application
4. **Binary patching**: xdelta3 delta application
5. **Multi-agent sync**: refresh sees other agents' changes
6. **Conflict detection**: PatchApplicationError on stale patches
7. **Edge cases**: empty files, unicode, large files, nested dirs

### Test Structure

```
packages/stream-fs/test-cases/
├── files/
│   ├── basic-operations.yaml
│   ├── text-patching.yaml
│   ├── binary-patching.yaml
│   └── large-files.yaml
├── directories/
│   ├── basic-operations.yaml
│   └── nested-directories.yaml
├── sync/
│   ├── multi-agent.yaml
│   └── conflict-detection.yaml
└── edge-cases/
    ├── unicode.yaml
    └── empty-files.yaml
```

## LLM Tools

Tools for AI agents to interact with the filesystem:

```typescript
// Read operations
const readFileTool = {
  name: "read_file",
  description: "Read the contents of a file",
  parameters: {
    path: { type: "string", description: "File path" }
  }
}

const listDirectoryTool = {
  name: "list_directory",
  description: "List files and directories",
  parameters: {
    path: { type: "string", description: "Directory path" }
  }
}

// Write operations
const createFileTool = {
  name: "create_file",
  description: "Create a new file with content",
  parameters: {
    path: { type: "string", description: "File path" },
    content: { type: "string", description: "File content" }
  }
}

const editFileTool = {
  name: "edit_file",
  description: "Edit a text file by replacing a unique string",
  parameters: {
    path: { type: "string", description: "File path" },
    old_str: { type: "string", description: "Exact text to find (must appear exactly once)" },
    new_str: { type: "string", description: "Replacement text" }
  }
}

const deleteFileTool = {
  name: "delete_file",
  description: "Delete a file",
  parameters: {
    path: { type: "string", description: "File path" }
  }
}

// Directory operations
const mkdirTool = {
  name: "mkdir",
  description: "Create a directory",
  parameters: {
    path: { type: "string", description: "Directory path" }
  }
}
```

## Implementation Phases

### Phase 1: Core Infrastructure
1. Add `patch` operation to `@durable-streams/state`
2. Create `@durable-streams/stream-fs` package structure
3. Define TypeScript types and interfaces

### Phase 2: Text Files
1. Implement text file create/read/write/delete
2. Integrate diff-match-patch for efficient updates
3. Write conformance tests for text operations

### Phase 3: Binary Files
1. Integrate xdelta3-wasm for binary deltas
2. Implement binary file operations
3. Write conformance tests for binary operations

### Phase 4: Multi-language Support
1. Python client implementation
2. Conformance test runner for Python

### Phase 5: LLM Integration
1. Create example app with tool definitions
2. Implement tool handlers
3. Demo with Claude/GPT integration

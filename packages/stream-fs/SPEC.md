# Stream-FS Specification

A shared filesystem for AI agents built on durable streams.

## Overview

Stream-FS provides POSIX-like filesystem semantics on top of durable streams, enabling multiple AI agents to collaborate on a shared filesystem with eventual consistency.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent 1   Agent 2   Agent N          │
│                       │         │         │             │
│                       ▼         ▼         ▼             │
│              ┌─────────────────────────────────┐        │
│              │      StreamFilesystem          │        │
│              │  (materialized view of streams) │        │
│              └─────────────────────────────────┘        │
│                              │                          │
│              ┌───────────────┴───────────────┐          │
│              ▼                               ▼          │
│    ┌──────────────────┐         ┌──────────────────┐    │
│    │  Metadata Stream │         │  Content Streams │    │
│    │   (/_metadata)   │         │ (/_content/{id}) │    │
│    └──────────────────┘         └──────────────────┘    │
│              │                           │              │
│              └───────────┬───────────────┘              │
│                          ▼                              │
│              ┌──────────────────────┐                   │
│              │   Durable Streams    │                   │
│              │       Server         │                   │
│              └──────────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

---

## Affordances (What You Can Do)

### File Operations

- **createFile(path, content, options?)**: Create a new file with content
- **writeFile(path, content)**: Replace file content (uses patches for efficiency)
- **readFile(path)**: Read file content as bytes
- **readTextFile(path)**: Read file content as text
- **deleteFile(path)**: Delete a file
- **applyTextPatch(path, patch)**: Apply a diff-match-patch to text file

### Directory Operations

- **mkdir(path)**: Create a new directory
- **rmdir(path)**: Remove an empty directory
- **list(path)**: List directory contents

### Metadata Operations

- **exists(path)**: Check if path exists
- **isDirectory(path)**: Check if path is a directory
- **stat(path)**: Get file or directory stats

### Synchronization

- **initialize()**: Load state from streams
- **watch(options?)**: Watch for changes via live SSE on metadata stream. Returns a Watcher with chokidar-style events (`add`, `change`, `unlink`, `addDir`, `unlinkDir`). Supports path filtering and `recursive` option.
- **close()**: Close all stream handles and watchers

### Cache Management

- **evictFromCache(path)**: Remove file from content cache
- **clearContentCache()**: Clear all cached content

---

## Invariants (What You Can Rely On)

### I1: Path Normalization Idempotence

```
∀ path: normalize(normalize(path)) = normalize(path)
```

Path normalization is idempotent. Normalizing an already-normalized path returns the same path.

### I2: Canonical Path Form

```
∀ path: normalize(path).startsWith("/")
∀ path ≠ "/": ¬normalize(path).endsWith("/")
```

All normalized paths start with "/" and (except root) do not end with "/".

### I3: Filesystem Tree Consistency

```
∀ file at path /a/b/c: ∃ directory at /a/b
∀ directory at path /a/b (b ≠ ""): ∃ directory at /a
```

Every file and non-root directory has a parent directory.

### I4: Single Entity Per Path

```
∀ path: ¬(isFile(path) ∧ isDirectory(path))
```

A path cannot be both a file and a directory simultaneously.

### I5: Metadata-Content Consistency

```
∀ file f:
  f.metadata.size = byteLength(f.content)
  f.metadata.contentStreamId → valid content stream
```

File metadata accurately reflects content state.

### I6: Patch Roundtrip Correctness

```
∀ texts a, b:
  applyPatch(a, createPatch(a, b)) = b
```

Creating and applying a patch produces the expected result.

### I7: Patch Identity

```
∀ text a:
  createPatch(a, a) = ""
  applyPatch(a, "") = a
```

Patching identical content produces empty patch; empty patch is identity.

### I8: Multi-Agent Eventual Consistency

```
∀ agents A, B sharing streamPrefix:
  when both are watching (or freshly initialized):
    snapshot(A) = snapshot(B)
```

All agents converge to the same state via watching or re-initialization.

### I9: Content Stream Replay Determinism

```
∀ content stream S:
  replay(events(S)) always produces same content
```

Replaying a content stream's events always yields the same final content.

### I10: Modification Time Monotonicity

```
∀ file f, write operations w1, w2 where w1 < w2:
  f.modifiedAt after w2 ≥ f.modifiedAt after w1
```

File modification times never decrease.

### I11: Delete Completeness

```
After deleteFile(path):
  ¬exists(path)
  content stream for path is deleted
  path removed from metadata stream
```

Deleting a file removes it completely from all streams.

### I12: Watch-Driven Cache Invalidation

```
Given: watcher active from offset O
When:  MetadataEvent for file with cached content arrives
Then:  contentCache and contentOffsets for that file are invalidated
Effect: next read returns fresh content from stream without refresh()
```

A watcher's SSE handler invalidates cached content for modified or deleted files, so subsequent reads return fresh data without requiring an explicit `refresh()`.

### I13: Stale-Write Detection

```
Given: agent reads file f at metadata state M1
When:  file f is modified (locally or via watch), producing state M2
       where M1.modifiedAt ≠ M2.modifiedAt
Then:  writeFile(f) and applyTextPatch(f) throw PreconditionFailedError
```

If a file has been modified since the last read, write operations fail with `PreconditionFailedError`. The agent must re-read the file to obtain the current state before writing. This prevents silent data loss from concurrent modifications.

---

## Constraints (What You Cannot Do)

### C1: No File Without Parent

```
createFile("/a/b/c", content) requires exists("/a/b") ∧ isDirectory("/a/b")
```

Cannot create a file unless its parent directory exists.

### C2: No Directory Without Parent

```
mkdir("/a/b") requires exists("/a") ∧ isDirectory("/a")
```

Cannot create a directory unless its parent exists (except root).

### C3: No Duplicate Paths

```
createFile(path, _) requires ¬exists(path)
mkdir(path) requires ¬exists(path)
```

Cannot create a file or directory at a path that already exists.

### C4: No Write to Non-Existent File

```
writeFile(path, _) requires exists(path) ∧ isFile(path)
```

Cannot write to a file that doesn't exist.

### C5: No Remove Non-Empty Directory

```
rmdir(path) requires list(path).length = 0
```

Cannot remove a directory that contains files or subdirectories.

### C6: No Remove Root

```
rmdir("/") always fails
```

Cannot remove the root directory.

### C7: No Read Directory as File

```
readFile(path) requires isFile(path)
readTextFile(path) requires isFile(path)
```

Cannot read a directory as if it were a file.

### C8: No List File as Directory

```
list(path) requires isDirectory(path)
```

Cannot list a file as if it were a directory.

### C9: No Binary Patch

```
applyTextPatch(path, _) requires file(path).contentType = "text"
```

Cannot apply text patches to binary files.

### C10: No Operations Before Initialize

```
∀ operation ≠ initialize:
  operation requires initialized = true
```

All operations except initialize() require prior initialization.

---

## Error Types

| Error                     | Condition                     | POSIX Equivalent |
| ------------------------- | ----------------------------- | ---------------- |
| `NotFoundError`           | Path does not exist           | ENOENT           |
| `ExistsError`             | Path already exists           | EEXIST           |
| `IsDirectoryError`        | Expected file, got directory  | EISDIR           |
| `NotDirectoryError`       | Expected directory, got file  | ENOTDIR          |
| `DirectoryNotEmptyError`  | Directory has children        | ENOTEMPTY        |
| `PatchApplicationError`   | Patch cannot be applied       | N/A              |
| `PreconditionFailedError` | File modified since last read | N/A (ECONFLICT)  |

---

## Consistency Model

Stream-FS provides **eventual consistency** with the following guarantees:

1. **Read-Your-Writes**: Within a single agent instance, reads reflect prior writes
2. **Monotonic Reads**: Once a value is read, subsequent reads return same or newer value
3. **Causal Consistency**: If agent A's write causally precedes agent B's read, B sees A's write after watching or re-initialization

### Conflict Resolution

When multiple agents write concurrently:

- **Metadata conflicts**: Last-writer-wins based on stream append order
- **Content conflicts**: Last-writer-wins; patches applied in stream order

### Watch Semantics

`watch()` subscribes to the metadata stream via SSE and automatically keeps the in-memory state up to date:

1. New metadata events update file/directory maps in real time
2. Content cache is invalidated when files are modified or deleted (I12)
3. Stale-write detection triggers on concurrent modifications (I13)

---

## Stream Event Formats

### Metadata Events

```typescript
type MetadataEvent =
  | { type: "insert"; key: string; value: FileMetadata | DirectoryMetadata }
  | { type: "update"; key: string; value: FileMetadata | DirectoryMetadata }
  | { type: "delete"; key: string }
```

### Content Events

```typescript
type ContentEvent =
  | { op: "init"; content: string; checksum: string }
  | { op: "replace"; content: string; checksum: string; encoding?: "base64" }
  | { op: "patch"; patch: string; checksum: string }
```

---

## Checker Metadata

### Invariant Checker Properties

| Checker               | Soundness | Completeness | Scope              |
| --------------------- | --------- | ------------ | ------------------ |
| TreeConsistency       | Sound     | Complete     | Single snapshot    |
| PathNormalization     | Sound     | Complete     | Path strings       |
| PatchRoundtrip        | Sound     | Complete     | Text pairs         |
| MultiAgentConvergence | Sound     | Incomplete   | Finite agent count |

---

## Test Categories

1. **Conformance Tests**: Verify each affordance works correctly
2. **Invariant Tests**: Verify invariants hold after operations
3. **Constraint Tests**: Verify constraints are enforced (errors thrown)
4. **Property Tests**: Algebraic properties of operations
5. **Fuzz Tests**: Random operation sequences
6. **Multi-Agent Tests**: Concurrent access patterns
7. **Adversarial Tests**: Malformed inputs, edge cases
8. **Exhaustive Tests**: All combinations in small scope

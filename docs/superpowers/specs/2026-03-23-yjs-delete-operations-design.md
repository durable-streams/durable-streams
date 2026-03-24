# Yjs DELETE operations design

**Date:** 2026-03-24
**Status:** Draft
**Branch:** feat/awareness-put-and-index

---

## Context

PR #296 added explicit PUT support for creating named awareness streams with index tracking. This design adds DELETE operations to the Yjs protocol for document lifecycle management.

## Scope

- DELETE document (cascading to snapshots and awareness)
- DELETE individual awareness streams
- Snapshot deletion is internal only (compaction + document delete cascade)

## Protocol additions

### Method table update

| Endpoint                          | Supported methods            | All other methods      |
| --------------------------------- | ---------------------------- | ---------------------- |
| `{document-url}`                  | GET, HEAD, POST, PUT, DELETE | 405 Method Not Allowed |
| `{document-url}?awareness=<name>` | GET, HEAD, POST, PUT, DELETE | 405 Method Not Allowed |

### 5.9. Delete document

Deletes a document and its associated state.

#### Request

```
DELETE {document-url}
```

#### Response

```
HTTP/1.1 204 No Content
```

#### Response (document does not exist)

```
HTTP/1.1 404 Not Found
```

The server MUST return error code `DOCUMENT_NOT_FOUND`.

#### Behavior

The server MUST delete the document update stream. The server SHOULD delete all associated snapshot and awareness streams visible at the time the operation is issued. Servers MAY implement background cleanup of orphaned streams.

After deletion, all operations on the document and its awareness URLs MUST return `404 Not Found`, except PUT on the document URL which creates a new document (Section 5.1).

### 5.10. Delete awareness stream

Deletes a named awareness stream. The parent document is unaffected.

#### Request

```
DELETE {document-url}?awareness=<name>
```

#### Response

```
HTTP/1.1 204 No Content
```

#### Response (stream does not exist)

```
HTTP/1.1 404 Not Found
```

#### Behavior

The server MUST delete the specified awareness stream. The server SHOULD remove the stream's entry from the awareness index on a best-effort basis.

### Amendment to 5.7. Awareness broadcast

When the server auto-creates an awareness stream on POST (e.g., after TTL expiry), the server MUST verify that the parent document exists. If the document does not exist, the server MUST return `404 Not Found` with error code `DOCUMENT_NOT_FOUND`.

## Design decisions

1. **No tombstones.** Deletion is best-effort cascade, not soft-delete. This avoids adding metadata or marker streams to the base protocol.

2. **Index-driven discovery.** The server reads the snapshot index and awareness index to discover streams to delete. Indexes are advisory — missing entries do not prevent cleanup, stale entries are tolerated.

3. **Snapshot deletion is not user-facing.** Snapshots are managed internally by compaction and document deletion. No protocol-level DELETE operation for individual snapshots.

4. **Cleanup on creation.** When creating a document, the server SHOULD clean up orphaned streams from a prior incarnation at the same URL. This follows the same baseline guarantees as the Durable Streams Protocol for stream deletion and recreation.

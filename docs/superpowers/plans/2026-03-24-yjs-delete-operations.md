# Yjs DELETE Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DELETE operations for Yjs documents and awareness streams per the design spec at `docs/superpowers/specs/2026-03-23-yjs-delete-operations-design.md`.

**Architecture:** DELETE document cascades to snapshots (via index-driven discovery) and the default awareness stream. Named awareness streams cannot be discovered (no awareness index exists) and are left as orphans that expire via TTL. DELETE awareness deletes a single named stream. Both are implemented in the Yjs server layer (`yjs-server.ts`) using existing `DurableStream.delete()`. The `postWithAutoCreate` method gains a document existence check. Protocol spec and conformance tests are updated.

**Tech Stack:** TypeScript (Yjs server), Vitest (conformance tests), `@durable-streams/client` (DurableStream API)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/y-durable-streams/src/server/yjs-server.ts` | Modify | Add DELETE handlers, update postWithAutoCreate |
| `packages/y-durable-streams/test/yjs-conformance.test.ts` | Modify | Add DELETE conformance tests, update 405 tests |
| `packages/y-durable-streams/YJS-PROTOCOL.md` | Modify | Add sections 5.9, 5.10, amend 5.7, update method table |

---

### Task 1: Conformance tests for document DELETE

**Files:**
- Modify: `packages/y-durable-streams/test/yjs-conformance.test.ts`

- [ ] **Step 1: Add `delete.doc-returns-204` test**

Inside the `Awareness Stream Management` describe block (after the last test), add a new top-level `Document Deletion` describe block:

```typescript
describe(`Document Deletion`, () => {
  describe(`delete.doc-returns-204`, () => {
    it(`should delete an existing document and return 204`, async () => {
      const docId = `del-doc-204-${Date.now()}`
      await createDocument(baseUrl, docId)

      const response = await fetch(`${baseUrl}/docs/${docId}`, {
        method: `DELETE`,
      })
      expect(response.status).toBe(204)
    })
  })
})
```

- [ ] **Step 2: Add `delete.doc-returns-404` test**

```typescript
describe(`delete.doc-returns-404`, () => {
  it(`should return 404 when deleting non-existent document`, async () => {
    const docId = `del-doc-404-${Date.now()}`
    const response = await fetch(`${baseUrl}/docs/${docId}`, {
      method: `DELETE`,
    })
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe(`DOCUMENT_NOT_FOUND`)
  })
})
```

- [ ] **Step 3: Add `delete.doc-then-get-returns-404` test**

```typescript
describe(`delete.doc-then-get-returns-404`, () => {
  it(`should return 404 on GET after document deletion`, async () => {
    const docId = `del-doc-get-${Date.now()}`
    await createDocument(baseUrl, docId)

    await fetch(`${baseUrl}/docs/${docId}`, { method: `DELETE` })

    const getResponse = await fetch(`${baseUrl}/docs/${docId}?offset=-1`)
    expect(getResponse.status).toBe(404)
  })
})
```

- [ ] **Step 4: Add `delete.doc-then-post-returns-404` test**

```typescript
describe(`delete.doc-then-post-returns-404`, () => {
  it(`should return 404 on POST after document deletion`, async () => {
    const docId = `del-doc-post-${Date.now()}`
    await createDocument(baseUrl, docId)

    await fetch(`${baseUrl}/docs/${docId}`, { method: `DELETE` })

    const postResponse = await fetch(`${baseUrl}/docs/${docId}`, {
      method: `POST`,
      headers: { "content-type": `application/octet-stream` },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(postResponse.status).toBe(404)
  })
})
```

- [ ] **Step 5: Add `delete.doc-then-put-creates-fresh` test**

```typescript
describe(`delete.doc-then-put-creates-fresh`, () => {
  it(`should create a fresh document after deletion`, async () => {
    const docId = `del-doc-recreate-${Date.now()}`
    await createDocument(baseUrl, docId)

    await fetch(`${baseUrl}/docs/${docId}`, { method: `DELETE` })

    const putResponse = await fetch(`${baseUrl}/docs/${docId}`, {
      method: `PUT`,
    })
    expect(putResponse.status).toBe(201)
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'FAIL|PASS|delete\.'`

Expected: All `delete.*` tests FAIL (405 Method Not Allowed or similar).

- [ ] **Step 7: Commit**

```bash
git add packages/y-durable-streams/test/yjs-conformance.test.ts
git commit -m "test: add conformance tests for document DELETE"
```

---

### Task 2: Conformance tests for awareness DELETE

**Files:**
- Modify: `packages/y-durable-streams/test/yjs-conformance.test.ts`

- [ ] **Step 1: Add `delete.awareness-returns-204` test**

Inside the `Document Deletion` describe block:

```typescript
describe(`delete.awareness-returns-204`, () => {
  it(`should delete an existing awareness stream and return 204`, async () => {
    const docId = `del-aw-204-${Date.now()}`
    await createDocument(baseUrl, docId)

    // Create a named awareness stream
    const putRes = await fetch(
      `${baseUrl}/docs/${docId}?awareness=cursors`,
      { method: `PUT` }
    )
    expect(putRes.status).toBe(201)
    await putRes.arrayBuffer()

    const deleteRes = await fetch(
      `${baseUrl}/docs/${docId}?awareness=cursors`,
      { method: `DELETE` }
    )
    expect(deleteRes.status).toBe(204)
  })
})
```

- [ ] **Step 2: Add `delete.awareness-returns-404` test**

```typescript
describe(`delete.awareness-returns-404`, () => {
  it(`should return 404 when deleting non-existent awareness stream`, async () => {
    const docId = `del-aw-404-${Date.now()}`
    await createDocument(baseUrl, docId)

    const response = await fetch(
      `${baseUrl}/docs/${docId}?awareness=nonexistent`,
      { method: `DELETE` }
    )
    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 3: Add `delete.awareness-preserves-document` test**

```typescript
describe(`delete.awareness-preserves-document`, () => {
  it(`should not affect the parent document when deleting awareness`, async () => {
    const docId = `del-aw-preserve-${Date.now()}`
    await createDocument(baseUrl, docId)

    // Delete default awareness
    const deleteRes = await fetch(
      `${baseUrl}/docs/${docId}?awareness=default`,
      { method: `DELETE` }
    )
    expect(deleteRes.status).toBe(204)

    // Document should still be accessible
    const headRes = await fetch(`${baseUrl}/docs/${docId}`, {
      method: `HEAD`,
    })
    expect(headRes.status).toBe(200)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'FAIL|PASS|delete\.'`

Expected: All new `delete.awareness-*` tests FAIL.

- [ ] **Step 5: Commit**

```bash
git add packages/y-durable-streams/test/yjs-conformance.test.ts
git commit -m "test: add conformance tests for awareness DELETE"
```

---

### Task 3: Conformance test for awareness POST document existence check

**Files:**
- Modify: `packages/y-durable-streams/test/yjs-conformance.test.ts`

- [ ] **Step 1: Add `delete.awareness-post-requires-document` test**

This tests the 5.7 amendment: POST to awareness auto-create must check document existence.

```typescript
describe(`delete.awareness-post-requires-document`, () => {
  it(`should return 404 on awareness POST after document deletion`, async () => {
    const docId = `del-aw-post-${Date.now()}`
    await createDocument(baseUrl, docId)

    // Delete the document
    await fetch(`${baseUrl}/docs/${docId}`, { method: `DELETE` })

    // POST to awareness — should NOT auto-create on deleted document
    const postRes = await fetch(
      `${baseUrl}/docs/${docId}?awareness=default`,
      {
        method: `POST`,
        headers: { "content-type": `application/octet-stream` },
        body: new Uint8Array([1, 2, 3]),
      }
    )
    expect(postRes.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'delete\.awareness-post'`

Expected: FAIL (currently auto-creates without checking document existence).

- [ ] **Step 3: Commit**

```bash
git add packages/y-durable-streams/test/yjs-conformance.test.ts
git commit -m "test: add conformance test for awareness POST document check"
```

---

### Task 4: Implement document DELETE handler

**Files:**
- Modify: `packages/y-durable-streams/src/server/yjs-server.ts`

- [ ] **Step 1: Add `handleDocumentDelete` method**

Add this method to the `YjsServer` class, after the `handleUpdateWrite` method (~line 793):

```typescript
/**
 * DELETE - Delete document and cascade to associated streams.
 */
private async handleDocumentDelete(
  res: ServerResponse,
  route: RouteMatch
): Promise<void> {
  const { service, docPath } = route
  const dsPath = YjsStreamPaths.dsStream(service, docPath)
  const dsUrl = `${this.dsServerUrl}${dsPath}`

  // Delete the document update stream (MUST)
  const response = await fetch(dsUrl, {
    method: `DELETE`,
    headers: this.dsServerHeaders,
  })

  if (response.status === 404) {
    await response.arrayBuffer()
    res.writeHead(404, { "content-type": `application/json` })
    res.end(
      JSON.stringify({
        error: {
          code: `DOCUMENT_NOT_FOUND`,
          message: `Document does not exist`,
        },
      })
    )
    return
  }

  if (!response.ok) {
    const text = await response.text().catch(() => ``)
    throw new Error(`Failed to delete document stream: ${response.status} ${text}`)
  }

  await response.arrayBuffer()

  // Clean up in-memory state
  const stateKey = this.stateKey(service, docPath)
  this.documentStates.delete(stateKey)

  // Best-effort cascade: delete associated streams (SHOULD)
  // Awaited so streams are deleted before responding, but errors don't fail the request
  await this.cascadeDeleteStreams(service, docPath).catch((err) => {
    console.error(`[YjsServer] Cascade delete failed for ${docPath}:`, err)
  })

  res.writeHead(204)
  res.end()
}
```

- [ ] **Step 2: Add `cascadeDeleteStreams` method**

Add after `handleDocumentDelete`:

```typescript
/**
 * Best-effort cascade delete of snapshot and awareness streams.
 * Errors are logged but do not propagate.
 */
private async cascadeDeleteStreams(
  service: string,
  docPath: string
): Promise<void> {
  const deleteStream = async (dsPath: string): Promise<void> => {
    try {
      await DurableStream.delete({
        url: `${this.dsServerUrl}${dsPath}`,
        headers: this.dsServerHeaders,
      })
    } catch {
      // Best-effort: ignore failures (stream may not exist)
    }
  }

  // Delete snapshots discovered via index
  const snapshotOffsets = await this.loadSnapshotOffsetsFromIndex(service, docPath)
  for (const offset of snapshotOffsets) {
    const snapshotKey = YjsStreamPaths.snapshotKey(offset)
    const snapshotPath = YjsStreamPaths.snapshotStream(service, docPath, snapshotKey)
    await deleteStream(snapshotPath)
  }

  // Delete index stream
  const indexPath = YjsStreamPaths.indexStream(service, docPath)
  await deleteStream(indexPath)

  // Delete default awareness stream
  const defaultAwarenessPath = YjsStreamPaths.awarenessStream(service, docPath, `default`)
  await deleteStream(defaultAwarenessPath)
}
```

- [ ] **Step 3: Add `loadSnapshotOffsetsFromIndex` method**

This reads the `.index` stream to discover all snapshot offsets. Follows the same pattern as the existing `loadSnapshotOffsetFromIndex` method (~line 461) but collects all offsets instead of just the latest. Add after `cascadeDeleteStreams`:

```typescript
/**
 * Load all snapshot offsets from the index stream.
 * Returns empty array if index doesn't exist.
 */
private async loadSnapshotOffsetsFromIndex(
  service: string,
  docPath: string
): Promise<string[]> {
  const indexUrl = `${this.dsServerUrl}${YjsStreamPaths.indexStream(service, docPath)}`

  try {
    const stream = new DurableStream({
      url: indexUrl,
      headers: this.dsServerHeaders,
      contentType: `application/json`,
    })

    const response = await stream.stream({ offset: `-1` })
    const body = await response.text()

    if (!body || body.trim().length === 0) {
      return []
    }

    const offsets: string[] = []

    // Prefer JSON array format (DS JSON streams return arrays)
    try {
      const parsed = JSON.parse(body) as unknown
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry?.snapshotOffset) {
            offsets.push(entry.snapshotOffset)
          }
        }
        return offsets
      }
    } catch {
      // Fall through to newline-delimited parsing
    }

    // Fallback: parse newline-delimited entries
    const lines = body.trim().split(`\n`)
    for (const line of lines) {
      const trimmed = line?.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as { snapshotOffset?: string }
        if (entry.snapshotOffset) {
          offsets.push(entry.snapshotOffset)
        }
      } catch {
        // Skip malformed entries
      }
    }

    return offsets
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Wire DELETE into the document request router**

In the main request handler, find the document method dispatch (around line 253, the PUT handler), and add DELETE before the final else:

```typescript
} else if (method === `DELETE`) {
  await this.handleDocumentDelete(res, route)
}
```

This replaces the existing fall-through to 405 for DELETE on document URLs.

- [ ] **Step 5: Run document DELETE tests**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'delete\.doc'`

Expected: `delete.doc-returns-204`, `delete.doc-returns-404`, `delete.doc-then-get-returns-404`, `delete.doc-then-post-returns-404`, `delete.doc-then-put-creates-fresh` all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/y-durable-streams/src/server/yjs-server.ts
git commit -m "feat: implement document DELETE with cascade"
```

---

### Task 5: Implement awareness DELETE handler

**Files:**
- Modify: `packages/y-durable-streams/src/server/yjs-server.ts`

- [ ] **Step 1: Add awareness DELETE handler**

In the `handleAwareness` method, find the `else if (method === 'HEAD')` block (around line 898) and add DELETE before the final else:

```typescript
} else if (method === `DELETE`) {
  // Delete awareness stream by proxying DELETE to DS server
  const response = await fetch(`${this.dsServerUrl}${dsPath}`, {
    method: `DELETE`,
    headers: this.dsServerHeaders,
  })

  if (response.status === 404) {
    await response.arrayBuffer()
    res.writeHead(404, { "content-type": `application/json` })
    res.end(
      JSON.stringify({
        error: { code: `STREAM_NOT_FOUND`, message: `Awareness stream not found` },
      })
    )
    return
  }

  await response.arrayBuffer()
  res.writeHead(response.status)
  res.end()
}
```

- [ ] **Step 2: Run awareness DELETE tests**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'delete\.awareness'`

Expected: `delete.awareness-returns-204`, `delete.awareness-returns-404`, `delete.awareness-preserves-document` all PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/y-durable-streams/src/server/yjs-server.ts
git commit -m "feat: implement awareness DELETE handler"
```

---

### Task 6: Add document existence check to awareness POST auto-create

**Files:**
- Modify: `packages/y-durable-streams/src/server/yjs-server.ts`

- [ ] **Step 1: Update `postWithAutoCreate` to check document existence**

The current `postWithAutoCreate` method (line 355) calls `tryCreateStream(dsPath)` on 404 without checking if the parent document exists. Update it to accept an optional `docDsPath` parameter for the document existence check.

**First**, update the method signature to accept an optional document path:

```typescript
private async postWithAutoCreate(
  req: IncomingMessage,
  res: ServerResponse,
  dsPath: string,
  docDsPath?: string
): Promise<void> {
```

**Then**, replace the body of the `if (response.status === 404)` block:

```typescript
if (response.status === 404) {
  // Stream doesn't exist — check parent document before re-creating
  await response.arrayBuffer()

  // If a document path was provided, verify the document exists
  if (docDsPath) {
    const headUrl = `${this.dsServerUrl}${docDsPath}`
    const headResponse = await fetch(headUrl, {
      method: `HEAD`,
      headers: this.dsServerHeaders,
    })

    if (headResponse.status === 404) {
      res.writeHead(404, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `DOCUMENT_NOT_FOUND`,
            message: `Document does not exist`,
          },
        })
      )
      return
    }
  }

  await this.tryCreateStream(dsPath)

  const retryResponse = await fetch(targetUrl, {
    method: `POST`,
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  })
  await this.forwardResponse(res, retryResponse)
}
```

**Finally**, update the call site in `handleAwareness` (~line 874) to pass the document path:

```typescript
const docDsPath = YjsStreamPaths.dsStream(route.service, route.docPath)
await this.postWithAutoCreate(req, res, dsPath, docDsPath)
```

- [ ] **Step 2: Run awareness POST test**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'delete\.awareness-post|awareness\.post-auto'`

Expected: `delete.awareness-post-requires-document` PASSES. Existing `awareness.post-auto-creates` tests still PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/y-durable-streams/src/server/yjs-server.ts
git commit -m "feat: check document existence on awareness POST auto-create"
```

---

### Task 7: Update 405 method validation tests

**Files:**
- Modify: `packages/y-durable-streams/test/yjs-conformance.test.ts`

- [ ] **Step 1: Update method validation tests**

The existing tests at ~line 1748 loop over `['DELETE', 'PATCH']` for unsupported methods. DELETE is now supported. Update to only test PATCH:

```typescript
const unsupportedDocMethods = [`PATCH`]
```

And similarly for awareness:

```typescript
const unsupportedAwarenessMethods = [`PATCH`]
```

- [ ] **Step 2: Run method validation tests**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'method\.'`

Expected: PATCH tests PASS. No DELETE 405 test remains.

- [ ] **Step 3: Run full test suite**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose`

Expected: All tests PASS including old and new.

- [ ] **Step 4: Commit**

```bash
git add packages/y-durable-streams/test/yjs-conformance.test.ts
git commit -m "test: update method validation — DELETE now supported"
```

---

### Task 8: Add cascade conformance tests

**Files:**
- Modify: `packages/y-durable-streams/test/yjs-conformance.test.ts`

- [ ] **Step 1: Add `delete.doc-cascades-awareness` test**

```typescript
describe(`delete.doc-cascades-awareness`, () => {
  it(`should delete awareness streams when document is deleted`, async () => {
    const docId = `del-cascade-aw-${Date.now()}`
    await createDocument(baseUrl, docId)

    // Verify default awareness stream exists
    const headBefore = await fetch(
      `${baseUrl}/docs/${docId}?awareness=default`,
      { method: `HEAD` }
    )
    expect(headBefore.status).toBe(200)

    // Delete document
    const deleteRes = await fetch(`${baseUrl}/docs/${docId}`, {
      method: `DELETE`,
    })
    expect(deleteRes.status).toBe(204)

    // Awareness operations should return 404
    const headAfter = await fetch(
      `${baseUrl}/docs/${docId}?awareness=default`,
      { method: `HEAD` }
    )
    expect(headAfter.status).toBe(404)
  })
})
```

- [ ] **Step 2: Add `delete.doc-cascades-snapshots` test**

This requires triggering compaction first:

```typescript
describe(`delete.doc-cascades-snapshots`, () => {
  it(`should delete snapshot streams when document is deleted`, async () => {
    const docId = `del-cascade-snap-${Date.now()}`
    const provider = await createProviderWithDoc(docId)
    await waitForSync(provider)

    // Write enough data to trigger compaction (threshold is 1500 bytes)
    const text = provider.doc.getText(`test`)
    for (let i = 0; i < 10; i++) {
      text.insert(0, `x`.repeat(200))
    }
    await provider.flush()

    // Wait for snapshot to be created
    await waitForSnapshot(baseUrl, docId)

    // Get snapshot offset from discovery
    const discoveryRes = await fetch(
      `${baseUrl}/docs/${docId}?offset=snapshot`,
      { redirect: `manual` }
    )
    expect(discoveryRes.status).toBe(307)
    const location = discoveryRes.headers.get(`location`)!
    expect(location).toContain(`_snapshot`)

    // Build full snapshot URL (location may be relative)
    const snapshotUrl = location.startsWith(`http`)
      ? location
      : `${baseUrl}/docs/${docId}?offset=${new URL(location, `http://localhost`).searchParams.get(`offset`)}`

    // Verify snapshot exists
    const snapshotRes = await fetch(snapshotUrl)
    expect(snapshotRes.status).toBe(200)
    await snapshotRes.arrayBuffer()

    provider.destroy()

    // Delete document
    const deleteRes = await fetch(`${baseUrl}/docs/${docId}`, {
      method: `DELETE`,
    })
    expect(deleteRes.status).toBe(204)

    // Snapshot should be gone — document no longer exists so all offsets return 404
    const snapshotAfter = await fetch(snapshotUrl)
    expect(snapshotAfter.status).toBe(404)
  })
})
```

- [ ] **Step 3: Run cascade tests**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose 2>&1 | grep -E 'delete\.doc-cascades'`

Expected: Both PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/y-durable-streams/test/yjs-conformance.test.ts
git commit -m "test: add cascade conformance tests for document DELETE"
```

---

### Task 9: Update YJS-PROTOCOL.md

**Files:**
- Modify: `packages/y-durable-streams/YJS-PROTOCOL.md`

- [ ] **Step 1: Update method table in Section 5**

At ~line 164, change both rows to include DELETE:

```markdown
| `{document-url}`                  | GET, HEAD, POST, PUT, DELETE | 405 Method Not Allowed |
| `{document-url}?awareness=<name>` | GET, HEAD, POST, PUT, DELETE | 405 Method Not Allowed |
```

- [ ] **Step 2: Add Section 5.9 — Delete document**

After Section 5.8, add the content from the design spec. Use the same formatting style as existing sections (see Sections 5.1-5.8 for reference):

```markdown
### 5.9. Delete Document

Deletes a document and its associated state.

#### Request

\```
DELETE {document-url}
\```

#### Response

\```
HTTP/1.1 204 No Content
\```

#### Response (document does not exist)

\```
HTTP/1.1 404 Not Found
\```

The server MUST return error code `DOCUMENT_NOT_FOUND`.

#### Behavior

The server MUST delete the document update stream. The server SHOULD delete all associated snapshot and awareness streams visible at the time the operation is issued. Servers MAY implement background cleanup of orphaned streams.

After deletion, all operations on the document and its awareness URLs MUST return `404 Not Found`, except PUT on the document URL which creates a new document (Section 5.1).
```

- [ ] **Step 3: Add Section 5.10 — Delete awareness stream**

```markdown
### 5.10. Delete Awareness Stream

Deletes a named awareness stream. The parent document is unaffected.

#### Request

\```
DELETE {document-url}?awareness=<name>
\```

#### Response

\```
HTTP/1.1 204 No Content
\```

#### Response (stream does not exist)

\```
HTTP/1.1 404 Not Found
\```

#### Behavior

The server MUST delete the specified awareness stream.
```

- [ ] **Step 4: Add note to Section 5.7 about document existence check**

In Section 5.7 (Awareness Broadcast), after the existing behavior description, add:

```markdown
When the server auto-creates an awareness stream on POST (e.g., after TTL expiry), the server MUST verify that the parent document exists. If the document does not exist, the server MUST return `404 Not Found` with error code `DOCUMENT_NOT_FOUND`.
```

- [ ] **Step 5: Update conformance test table in Appendix A**

Replace the `method.doc-rejects-delete` and `method.awareness-rejects-delete` entries with new DELETE test entries:

```markdown
| `delete.doc-returns-204`                  | DELETE on existing document returns 204                               |
| `delete.doc-returns-404`                  | DELETE on non-existent document returns 404 DOCUMENT_NOT_FOUND        |
| `delete.doc-then-get-returns-404`         | GET after DELETE returns 404                                          |
| `delete.doc-then-post-returns-404`        | POST after DELETE returns 404                                         |
| `delete.doc-then-put-creates-fresh`       | PUT after DELETE creates new document (201)                           |
| `delete.doc-cascades-awareness`           | DELETE document removes associated awareness streams                  |
| `delete.doc-cascades-snapshots`           | DELETE document removes associated snapshots                          |
| `delete.awareness-returns-204`            | DELETE on existing awareness stream returns 204                       |
| `delete.awareness-returns-404`            | DELETE on non-existent awareness stream returns 404                   |
| `delete.awareness-preserves-document`     | DELETE awareness does not affect parent document                      |
| `delete.awareness-post-requires-document` | POST to awareness on deleted document returns 404 DOCUMENT_NOT_FOUND  |
```

- [ ] **Step 6: Update error code table**

Add `DOCUMENT_NOT_FOUND` for DELETE operations if not already in the error table for this context.

- [ ] **Step 7: Run full test suite one final time**

Run: `cd packages/y-durable-streams && npx vitest run test/yjs-conformance.test.ts --reporter=verbose`

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/y-durable-streams/YJS-PROTOCOL.md
git commit -m "docs: add DELETE sections 5.9, 5.10, amend 5.7, update conformance tests"
```

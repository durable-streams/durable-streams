# Forkable streams design

**Date:** 2026-03-27
**Status:** Draft

## Summary

Fork is a protocol-level operation for Durable Streams that creates a new stream
inheriting data from a source stream up to a specified offset. Fork is O(1)
metadata — no data is copied. The read path walks the fork chain at read time,
stitching source and fork data transparently. Stream-level refcounting provides
lifecycle independence between source and fork.

## Motivation

- **Branching**: explore alternative approaches in parallel, pick a winner
- **Scratch buffers**: disposable contexts that don't pollute the main timeline
- **Correction**: fork from before an error to retry
- **Templates**: fork a golden history to bootstrap new contexts

Fork must be cheap — O(1) metadata — because consumers may create thousands of
forks simultaneously.

## Protocol surface

### Fork creation

Fork is a variant of stream creation via `PUT`:

```
PUT /new/stream/path
Content-Type: application/json
Stream-Forked-From: /source/stream/path
Stream-Fork-Offset: 0000000000000000_0000000000000500
```

**Request headers (fork-specific, in addition to existing PUT headers):**

- `Stream-Forked-From: <source-path>` — source stream to fork from (required
  for fork)
- `Stream-Fork-Offset: <offset>` — divergence point in source stream (optional;
  defaults to source's current tail)

All existing `PUT` headers work:

- `Content-Type` is inherited from source if not specified
- `Stream-TTL` / `Stream-Expires-At` are capped at source's expiry
- `Stream-Closed: true` is allowed (create a closed fork)

**Request body:** Optional. If provided, the body is appended as the fork's
first data (starting at the fork offset), same as regular `PUT` with initial
data.

**Response:** Same as regular `PUT` — `201 Created` with `Stream-Next-Offset`
set to the fork offset (or past it, if initial data was provided).

**Errors:**

| Condition | Status |
|-----------|--------|
| Source stream not found | 404 |
| Fork offset beyond source stream length | 400 |
| Invalid offset format | 400 |
| Target path already in use | 409 |
| Source is soft-deleted | 409 |

**Idempotency:** Same as regular `PUT`. If stream already exists with matching
config (including `Stream-Forked-From` and `Stream-Fork-Offset`), return
`200 OK`. Otherwise `409 Conflict`.

### Fork-info response headers

On `HEAD`, `GET`, and the `PUT` creation response for forked streams:

- `Stream-Forked-From: /source/stream/path`
- `Stream-Fork-Offset: <offset>`

Non-forked streams do not include these headers.

### Refcount header

On `HEAD` and `GET` responses for all streams:

- `Stream-Ref-Count: <integer>` — number of forks referencing this stream
  (0 if none)

This is informational for observability. Non-forked streams with no forks return
`Stream-Ref-Count: 0`.

### No changes to other operations

- `POST` (append): works identically on forked streams
- `GET` (read): works identically, server stitches transparently
- `DELETE`: works identically from client's perspective (soft-delete when
  refcount > 0)

### Offset semantics

Offsets pass through from source — no translation. The forked stream uses the
same offset space as the source. The fork offset is the divergence point: source
data for offsets < fork_offset, fork's own data for offsets >= fork_offset.

Clients see one continuous stream. A reader starting at offset 0 on a fork reads
inherited data from 0 to fork_offset, then the fork's own data from fork_offset
onward. Offsets are identical to what they would have been on the source stream
up to the divergence point.

### Closed stream behavior

Closed streams can be forked. The fork starts in the open state regardless of
the source's closed status. This enables "fork from before an error" and
"template" use cases.

## Store layer and read path

### Metadata changes

Four new fields on `StreamMetadata`:

| Field | Type | Description |
|-------|------|-------------|
| `ForkedFrom` | string | Source stream path (empty if not a fork) |
| `ForkOffset` | Offset | Divergence point |
| `RefCount` | int32 | Number of forks referencing this stream |
| `SoftDeleted` | bool | Logically deleted but retained for forks |

`ForkedFrom` and `ForkOffset` are immutable after creation. `RefCount` is
maintained atomically via metadata transactions.

### Read path algorithm

1. Load metadata for the requested path. If `ForkedFrom` is empty, use existing
   read logic unchanged.
2. If the stream is a fork, determine where data lives:
   - `offset < ForkOffset`: read from source stream, capped at `ForkOffset`
   - `offset >= ForkOffset`: read from fork's own segment. Physical byte =
     `offset.ByteOffset - ForkOffset.ByteOffset`
3. **Boundary-spanning reads**: read from source up to `ForkOffset`, then
   continue from fork's own segment at physical byte 0. Concatenate into one
   response.
4. **Recursive forks**: if source is itself a fork, recurse. Build a chain of
   `(path, forkOffset)` pairs from leaf to root, then read from the appropriate
   segments. O(fork_depth) metadata lookups.
5. **Source tail boundary**: inherited reads stop at `ForkOffset`. Source appends
   after fork creation are never visible to the fork — the fork reads its own
   data in that offset range.

### Append path

- Fork's segment file starts empty at creation. Physical byte 0 corresponds to
  logical `ForkOffset`.
- Appends use existing `WriteMessage` machinery. `CurrentOffset` advances from
  `ForkOffset` upward.
- Translation: `physical_byte = logical_offset.ByteOffset - ForkOffset.ByteOffset`
- All existing validations (producer dedup, Stream-Seq, content type, closed
  state) apply unchanged.

### Create path (with fork headers)

1. Validate source exists (not soft-deleted, not expired)
2. Validate `ForkOffset`: `ZeroOffset <= ForkOffset <= source.CurrentOffset`
3. Atomically in one metadata transaction: increment source `RefCount` + create
   fork metadata with `CurrentOffset = ForkOffset`
4. Content-type inherited from source if not specified in request
5. Create empty segment file for fork's own data
6. Idempotent: if fork path already exists with matching config, return 200

### WaitForMessages (long-poll)

- **Offset in inherited range** (`< ForkOffset`): data exists in source,
  return immediately.
- **Offset at fork's tail** (`>= ForkOffset`, at `CurrentOffset`): wait
  normally. Only fork's own appends trigger notification. Source appends do not
  notify fork waiters.
- No structural changes to `longPollManager`.

### GetCurrentOffset

Returns `CurrentOffset` from metadata. For a fresh fork with no own appends,
this equals `ForkOffset`.

## Deletion, soft-delete, and cascading GC

### Delete path algorithm

1. Look up metadata. Not found → `ErrStreamNotFound`.
2. **refcount > 0**: set `SoftDeleted = true`. Persist atomically. Return
   success. Data stays.
3. **refcount == 0**: mark `SoftDeleted = true` and `pendingCleanup = true`. If
   this stream is a fork, decrement source's refcount in the same transaction.
   If that causes source refcount to hit 0 AND source is soft-deleted, mark
   source for cleanup too (cascade). Commit. Enqueue async data deletion.
4. **Refcount underflow guard**: if decrement would go below 0, abort
   transaction and log error.

### Cascading GC algorithm

Within a single metadata transaction:

1. Start with the deleted stream. Set `deleted`, `pendingCleanup`.
2. Walk `forkedFrom` chain upward:
   - Decrement parent's refcount
   - If parent refcount > 0 → stop
   - If parent refcount == 0 AND parent is soft-deleted → mark
     `pendingCleanup`, continue up chain
   - If parent refcount == 0 AND parent is NOT deleted → stop (live stream,
     refcount 0 just means no forks)
3. Commit transaction. Collect all `pendingCleanup` paths, enqueue async data
   deletion.

### Soft-delete behavior

| Operation | Allowed? | Response |
|-----------|----------|----------|
| Read (by fork, internal) | Yes | Data preserved for fork chain |
| Read (direct GET) | No | 410 Gone |
| HEAD | No | 410 Gone |
| Append (POST) | No | 410 Gone |
| New fork from this stream | No | 410 Gone |
| Re-creation (PUT same path) | No | 409 Conflict |
| Delete (again) | Idempotent | 204 |

### Data cleanup

**Inline (eager):** after metadata transaction commits, rename stream directory
to `.deleted~{name}~{ts}`, then async `RemoveAll`.

**Background sweeper (lazy):** periodic scan catches orphans from crashes. For
each stream where `deleted AND pendingCleanup AND refcount == 0`: verify
directory exists, rename, remove, delete metadata entry. Also scan for orphaned
`.deleted~` directories with no metadata entry.

### Failure modes

| Crash point | Recovery |
|-------------|----------|
| Before metadata commit | No change, retry delete |
| After commit, before rename | Sweeper picks up on next tick |
| After rename, before RemoveAll | Startup scan cleans tombstones |
| Mid-cascade transaction | Atomic — all or nothing, retry |

Worst case is leaked storage. Premature deletion is impossible — refcount gate
is always checked inside the metadata transaction.

## Expiry and TTL inheritance

### Fork creation with TTL

Source expiry is resolved to an absolute timestamp and used as a ceiling:

```
source_expiry = resolve_absolute_expiry(source)

if fork requests TTL:         fork_expiry = now + fork.TTLSeconds
elif fork requests ExpiresAt: fork_expiry = fork.ExpiresAt
else:                         fork_expiry = source_expiry

if source_expiry != nil and fork_expiry != nil:
    fork_expiry = min(fork_expiry, source_expiry)
```

The fork always stores the result as `ExpiresAt` (absolute timestamp), never
raw `TTLSeconds`. This avoids the bug where inheriting a raw TTL would compute
expiry relative to the fork's `CreatedAt`, silently extending the lifetime.

If the fork requests a longer TTL than the source allows, it is silently capped.
The client can inspect the returned `Stream-Expires-At` header.

### Expiry as soft-delete trigger

When `IsExpired()` fires, it triggers the same refcount-aware delete path:

- refcount == 0 → full delete
- refcount > 0 → soft-delete (data preserved for forks)

### Expired source with living forks

Source expires → soft-deleted. Fork reads continue (source data preserved). When
last fork is deleted or expires, cascading GC cleans up.

### Expired fork releases refcount

Same as manual delete: mark fork deleted, decrement source refcount in one
transaction, defer data cleanup. Cascade if applicable.

## Conformance tests

### Fork creation

1. Basic fork — fork at current head, verify exists and is readable
2. Fork at specific offset — verify inherited data ends at that offset
3. Fork at zero offset — fork starts empty (no inherited data)
4. Fork at head offset — all source data is inherited
5. Fork nonexistent stream — returns 404
6. Fork at offset beyond stream length — returns 400
7. Fork to path already in use — returns 409
8. Fork a closed stream — succeeds, fork starts open
9. Fork an empty stream — succeeds, fork inherits nothing
10. Fork preserves content-type — forked stream has same content-type as source

### Reading forked streams

11. Read entire fork — offset 0, get source data + fork data seamlessly
12. Read only inherited portion — offset in source range
13. Read only fork's own data — offset past fork point
14. Read across fork boundary — single read spanning source and fork, no gaps
15. Source appends after fork don't appear in fork
16. Fork headers present — `Stream-Forked-From` and `Stream-Fork-Offset`
    returned on HEAD/GET/PUT

### Appending to forked streams

17. Append to fork — data after fork point is readable
18. Append to source after fork — source independent, fork unaffected
19. Idempotent producer on fork — producer headers work normally
20. Close forked stream — independent of source
21. Close source doesn't affect fork — fork remains open and writable

### Recursive forks (fork of fork)

22. Fork a fork — C from B from A, read C gets all three levels
23. Fork a fork at mid-point of inherited data — C forks B within A's range
24. Three-level read correctness — no gaps or duplicates
25. Append at each level — each sees only its own chain

### Live modes on forked streams

26. Long-poll — inherited data available, returns immediately
27. Long-poll at fork's tail — waits for fork appends, not source appends
28. SSE on fork — delivers inherited data, fork data, then waits
29. Long-poll handover — correctly hands over at fork offset

### Deletion and lifecycle

30. Delete fork, source unaffected
31. Delete source while fork exists — soft-delete, fork still reads
32. Soft-deleted source blocks re-creation — PUT returns 409
33. Delete last fork, source GC cascades — soft-deleted source cleaned up
34. Three-level cascading GC — delete C, B and A cascade
35. Delete middle of chain — B deleted while C exists, data preserved
36. Refcount never goes below zero — delete non-fork stream, no underflow
37. Delete all forks, source still alive — refcount 0, source unaffected

### Expiry and TTL

38. Fork inherits source expiry
39. Fork with shorter TTL — capped at source expiry
40. Fork cannot exceed source expiry — gets capped
41. Expired fork releases refcount
42. Source expiry with living forks — soft-delete, fork reads continue

### JSON mode

43. Fork a JSON stream — content-type inherited, array wrapping works
44. Read forked JSON across boundary — correct wrapping from both sources

### Edge cases

45. Fork then immediately delete source — fork still readable
46. Many forks of same stream — 100 forks, all readable, refcount correct
47. Fork at every offset — offset 0, mid-stream, and tail all work
48. Concurrent fork and append to source — consistent snapshot

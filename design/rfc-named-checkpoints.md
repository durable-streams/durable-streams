# RFC: Named checkpoints for Durable Streams

**Status:** Draft
**Date:** 2026-03-25
**Authors:** Kevin, Claude

---

## Summary

This RFC proposes adding **named checkpoints** to the Durable Streams protocol. A checkpoint is a server-maintained pointer from a name to an offset in a stream. Clients resolve checkpoint names using the existing `offset` query parameter, and the server redirects to the stored offset.

Checkpoints are set automatically by the server based on configurable content matching rules, evaluated on each append to JSON-mode streams.

## Motivation

Streams that undergo compaction or have other logical resumption points need a way for late-joining readers to skip to the relevant starting position. Today, a reader must either:

- Read from `offset=-1` (the entire stream history), or
- Know the specific offset to start from (requires out-of-band coordination)

Neither is satisfactory. Reading the full history is wasteful when a compaction summary supersedes earlier entries. And sharing specific offsets requires a side-channel.

**Use cases:**

- **Claude Code session sharing** — a session stream contains a compaction boundary; late-joining viewers should start from the last compaction point, not the beginning
- **Yjs document sync** — new clients should start from the latest document snapshot, not replay all updates (the existing `offset=snapshot` mechanism in the Yjs protocol is a special case of this)
- **Any compacted or segmented stream** — event-sourced streams with periodic snapshots, log streams with rotation points, etc.

## Design

### Checkpoint as a named offset pointer

A checkpoint is a tuple of `(name, offset)` stored by the server per stream. It answers the question: "where should a reader start if they want to resume from the logical point identified by this name?"

Properties:

- **Named** — each checkpoint has a string name (e.g., `compact`, `snapshot`, `latest-turn`)
- **Last-write-wins** — storing a new offset for an existing name replaces the previous offset
- **Per-stream** — checkpoints are scoped to the stream they belong to
- **Durable** — checkpoints survive server restarts (they are stored alongside stream metadata)

### Reading from a checkpoint

Checkpoint names are a new class of **offset sentinel values**, alongside the existing `-1` (beginning) and `now` (current tail).

```
GET {stream-url}?offset=<checkpoint-name>
```

**Resolution behavior:**

- If a checkpoint with the given name exists for this stream, the server returns **307 Temporary Redirect** with `Location: {stream-url}?offset={stored-offset}`.
- If no checkpoint with the given name exists, the server returns **307 Temporary Redirect** with `Location: {stream-url}?offset=-1` (beginning of stream).

The redirect is always a 307 (not 301/302) because the checkpoint offset changes over time as new checkpoints are stored.

**With live modes:**

Checkpoint resolution works with all read modes. The server preserves additional query parameters through the redirect:

```
GET {stream-url}?offset=compact&live=sse
→ 307 Location: {stream-url}?offset={stored-offset}&live=sse
```

**Response headers on 307:**

- `Location: {stream-url}?offset={resolved-offset}[&...preserved-params]`
- `Cache-Control: no-store` — checkpoint resolution must not be cached, as the target offset changes over time

### Setting checkpoints

Checkpoints are set **server-side** on append. The server evaluates a configurable function against each appended message and, if it matches, records the message's offset as a named checkpoint.

```
shouldCheckpoint(message) → string | undefined
```

- Input: the appended message (parsed JSON for JSON-mode streams)
- Output: a checkpoint name (string) if this message should become a checkpoint, or `undefined` if not
- When a string is returned, the server atomically stores `(name, offset)` alongside the append

This function is configured on the server, not specified by the writer. The writer simply appends data; the server decides what constitutes a checkpoint.

**Scope:** For the initial implementation, `shouldCheckpoint` is defined only for **JSON-mode streams** (`Content-Type: application/json`), where the server already parses messages for array flattening. Binary streams may gain checkpoint support in a future extension (e.g., via writer-provided headers).

### Checkpoint name constraints

Checkpoint names:

- **MUST** match the pattern `[a-z][a-z0-9-]*` (lowercase ASCII letter, followed by lowercase alphanumeric or hyphens)
- **MUST** be between 1 and 64 characters
- **MUST NOT** collide with existing sentinel values (`-1`, `now`). Servers **MUST** reject checkpoint configurations that use reserved sentinel names.
- Are case-sensitive

Examples of valid names: `compact`, `snapshot`, `latest-turn`, `v2-migration-start`

### Distinguishing checkpoints from real offsets

The server needs to determine whether an `offset` query parameter value is a real offset, an existing sentinel (`-1`, `now`), or a checkpoint name.

Since real offsets are opaque but must be lexicographically sortable strings that do not contain `/`, `?`, `=`, `&`, or `,` (per Section 6 of the protocol), and existing sentinels are `-1` and `now`, the server can use the following resolution order:

1. Check if the value is a known sentinel (`-1`, `now`) — handle directly
2. Check if the value matches a registered checkpoint name for this stream — resolve via 307 redirect
3. Otherwise, treat as a real offset — proceed with normal read

Since checkpoint names start with `[a-z]` and real offsets produced by implementations typically start with digits (e.g., timestamp-based), collisions are unlikely in practice. However, servers **MUST** document their offset format so clients can understand the namespace. Checkpoint names that happen to be valid offsets are resolved as checkpoints (checkpoint lookup takes precedence over offset interpretation).

### Checkpoint storage

Checkpoints are lightweight metadata (a name-to-offset mapping) stored alongside the stream. Servers **SHOULD** store checkpoints in the same durability tier as stream metadata (so they survive restarts).

For the Caddy implementation:

- **Memory store**: checkpoints are stored in-memory alongside stream state
- **File store**: checkpoints are persisted to disk alongside stream data

Checkpoint storage is bounded: each stream has at most one offset per checkpoint name. With typical checkpoint configurations (1-3 names per stream), storage overhead is negligible.

### Checkpoint lifecycle

- **Creation**: a checkpoint is created when `shouldCheckpoint` first returns a given name for a stream
- **Update**: subsequent matches for the same name overwrite the stored offset (last-write-wins)
- **Deletion**: checkpoints are deleted when their stream is deleted. There is no explicit checkpoint deletion API in the initial version.
- **Interaction with stream closure**: checkpoints remain readable after a stream is closed. `offset=<name>` continues to resolve normally on closed streams.

---

## Protocol specification text

The following sections are written in the style of PROTOCOL.md and are intended to be incorporated into the protocol specification.

### Section 6 addition: checkpoint sentinel values

Add after the existing sentinel values (`-1` and `now`):

> **Named Checkpoints**: Servers **MAY** support named checkpoints as additional offset sentinel values. A checkpoint is a server-maintained mapping from a name to a stream offset, allowing clients to resolve logical resumption points without knowing specific offsets.
>
> When a server supports checkpoints and receives a `GET` request with `offset=<name>` where `<name>` matches a registered checkpoint for the target stream, the server **MUST** return `307 Temporary Redirect` with a `Location` header pointing to the same URL with `offset` replaced by the stored offset value. All other query parameters **MUST** be preserved in the redirect target.
>
> If `offset=<name>` does not match any registered checkpoint, the server **MUST** return `307 Temporary Redirect` with `offset=-1` (beginning of stream) as the fallback.
>
> Checkpoint names **MUST** match the pattern `[a-z][a-z0-9-]*` and be between 1 and 64 characters. They **MUST NOT** collide with reserved sentinel values (`-1`, `now`).
>
> The `307 Temporary Redirect` response **MUST** include `Cache-Control: no-store` to prevent caching of the redirect, as the checkpoint's target offset may change over time.
>
> **Resolution precedence**: When evaluating an `offset` query parameter value, servers **MUST** check in this order: (1) reserved sentinels (`-1`, `now`), (2) registered checkpoint names, (3) real offset values. Checkpoint names take precedence over offset interpretation.

### Section 9 addition: checkpoint extension

Add as a new subsection under Section 9 (Extensibility):

> ### 9.3. Checkpoints
>
> Servers **MAY** implement automatic checkpoint creation by inspecting appended messages and matching them against configurable rules. For JSON-mode streams (`Content-Type: application/json`), servers **MAY** evaluate a `shouldCheckpoint` function against each appended JSON message:
>
> ```
> shouldCheckpoint(message: JSON) → string | undefined
> ```
>
> When the function returns a non-empty string, the server **MUST** atomically store the append's offset as a checkpoint with the returned name. The checkpoint update **SHOULD** be atomic with the append operation to prevent windows where the checkpoint points to a stale offset.
>
> The mechanism for configuring `shouldCheckpoint` is implementation-defined. Servers **SHOULD** document their configuration syntax and supported matching capabilities.
>
> Servers **MAY** also support setting checkpoints via other mechanisms (e.g., request headers, explicit API calls) as implementation-specific extensions, provided the checkpoint resolution semantics defined in Section 6 are preserved.

---

## Caddy implementation

### Configuration syntax

Checkpoints are configured within the `durable_streams` directive:

```caddyfile
durable_streams {
    checkpoint <name> {
        json_match <path> <value>
        [json_match <path> <value>]
    }
}
```

- `<name>`: the checkpoint name (must match `[a-z][a-z0-9-]*`)
- `json_match <path> <value>`: a condition that must match. `<path>` is a dot-separated JSON path (e.g., `.type`, `.subtype`, `.metadata.kind`). `<value>` is the expected string value. Multiple `json_match` directives are ANDed together.

**Example — Claude Code compaction boundary:**

```caddyfile
durable_streams {
    checkpoint compact {
        json_match .type "system"
        json_match .subtype "compact_boundary"
    }
}
```

This stores a checkpoint named `compact` whenever a JSON message is appended where `.type == "system"` AND `.subtype == "compact_boundary"`.

**Example — Multiple checkpoints on the same stream:**

```caddyfile
durable_streams {
    checkpoint compact {
        json_match .type "system"
        json_match .subtype "compact_boundary"
    }
    checkpoint user-turn {
        json_match .type "user"
    }
}
```

### Matching semantics

- `json_match` operates on the **top-level JSON object** of each appended message
- Path syntax: dot-separated keys (e.g., `.type`, `.metadata.kind`). Array indexing is not supported in the initial version.
- Value comparison: exact string match. The JSON value at the path must be a string equal to the specified value. Non-string values (numbers, booleans, objects, arrays) do not match.
- Multiple `json_match` conditions within a checkpoint block are ANDed: all must match for the checkpoint to fire.
- If the path does not exist in the message, the condition does not match (no error).

### Evaluation on append

When a JSON-mode stream receives an append:

1. Parse the JSON message(s). For JSON arrays (which are flattened into individual messages per JSON mode), evaluate `shouldCheckpoint` on **each individual message**.
2. For each checkpoint rule, evaluate all `json_match` conditions against the message.
3. If all conditions match, store `(checkpoint_name, current_append_offset)` for this stream.
4. If multiple checkpoint rules match the same message, all are updated.
5. The checkpoint offset stored is the offset of the individual message that matched, not the offset of the entire append batch.

### Storage

Checkpoints are stored as part of the stream's metadata:

- **Memory store**: a `map[string]string` (name → offset) on the stream struct
- **File store**: written to a `{stream-path}/_checkpoints.json` file (or similar), updated atomically on each checkpoint change

### Redirect handling

When a GET request arrives with `offset=<value>`:

1. If `<value>` is `-1` or `now`: handle as existing sentinel
2. If `<value>` matches `[a-z][a-z0-9-]*` and a checkpoint with that name exists: return `307` redirect to `?offset={stored_offset}` (preserving all other query params)
3. If `<value>` matches the checkpoint name pattern but no checkpoint exists: return `307` redirect to `?offset=-1` (preserving all other query params)
4. Otherwise: treat as a real offset, proceed normally

---

## Conformance tests

The following test cases should be added to the server conformance test suite:

### Checkpoint creation

1. **Basic checkpoint creation** — append a JSON message matching a checkpoint rule, verify the checkpoint is stored
2. **Checkpoint update** — append two messages matching the same checkpoint, verify the checkpoint points to the second one (last-write-wins)
3. **Multiple checkpoints** — configure two checkpoint rules, append a message matching each, verify both checkpoints exist independently
4. **Non-matching message** — append a message that doesn't match any rule, verify no checkpoint is created
5. **Partial match** — append a message matching some but not all `json_match` conditions, verify no checkpoint is created

### Checkpoint resolution

6. **Basic resolution** — create a checkpoint, then GET with `offset=<name>`, verify 307 redirect to correct offset
7. **Resolution preserves query params** — GET with `offset=<name>&live=sse`, verify redirect includes `live=sse`
8. **Unknown checkpoint fallback** — GET with `offset=<name>` where no checkpoint exists, verify 307 redirect to `offset=-1`
9. **Checkpoint on closed stream** — close a stream with a checkpoint, verify resolution still works
10. **Checkpoint after multiple updates** — update a checkpoint several times, verify resolution returns the latest offset

### Sentinel precedence

11. **`-1` is not treated as a checkpoint** — even if a checkpoint named `-1` could theoretically exist (it can't due to name constraints, but verify the server doesn't attempt checkpoint lookup for `-1`)
12. **`now` is not treated as a checkpoint** — same as above for `now`
13. **Checkpoint takes precedence over offset** — if a checkpoint name happens to be a valid offset string (unlikely but possible), verify it resolves as a checkpoint

### Edge cases

14. **Checkpoint with JSON array append** — append a JSON array where one element matches, verify checkpoint points to that element's offset (not the batch offset)
15. **Empty stream with no checkpoint** — GET `offset=compact` on a stream with no appends, verify redirect to `offset=-1`
16. **Checkpoint name validation** — attempt to configure checkpoints with invalid names (uppercase, special characters, empty, >64 chars), verify rejection

---

## Migration path for Yjs `offset=snapshot`

The existing Yjs protocol uses `offset=snapshot` as a special sentinel that triggers a 307 redirect to the latest snapshot URL. Named checkpoints generalize this pattern.

The Yjs implementation can be migrated to use named checkpoints in a future iteration:

1. Register a checkpoint named `snapshot` on Yjs document streams
2. Update the Yjs compaction logic to set the `snapshot` checkpoint offset when a new snapshot is created
3. The Yjs client's `offset=snapshot` request would then be handled by the base checkpoint resolution logic instead of Yjs-specific code

This migration is **not a prerequisite** for the CC integration work and can be done independently.

---

## Alternatives considered

### Writer-side checkpoint marking (via request header)

Instead of server-side matching, the writer could mark checkpoints explicitly with a header like `Stream-Checkpoint: compact` on the POST request.

**Rejected because:**

- Pushes complexity to every writer (the sidecar needs to understand CC's JSONL format to detect compaction boundaries)
- Less flexible (adding a new checkpoint type requires updating the writer)
- Server-side matching keeps the writer simple — it just appends raw data

### Client-side scanning for checkpoints

Instead of server-side checkpoints, the viewer could read from `offset=-1` and scan for the last `compact_boundary` entry.

**Rejected because:**

- Defeats the purpose — the whole point is to avoid reading the entire stream
- Gets worse over time as streams grow
- Transfers the cost of checkpoint detection to every reader instead of amortizing it on the server

### Separate index stream

The writer could maintain a side-stream (e.g., `{stream-url}/_index`) that records checkpoint offsets, and readers would query the index first.

**Considered as a pragmatic alternative** that requires no protocol changes. Rejected for the long-term design because:

- Adds a coordination requirement between the writer and readers (both need to know the index stream convention)
- Two streams to manage per session instead of one
- The checkpoint primitive is generally useful and belongs in the protocol

However, this approach remains viable as a **stopgap** if the protocol change takes longer to ship than expected.

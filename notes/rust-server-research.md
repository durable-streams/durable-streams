# Research: a high-performance Rust server for Durable Streams

Goal: a new Rust server implementation of the Durable Streams protocol that is maximally
efficient — system-level zero-copy between network and file (both directions) and async
I/O end to end.

This document has three parts:

1. What the protocol requires (condensed from `PROTOCOL.md`)
2. How the existing servers (Go caddy-plugin, TS dev server) are built, and what that
   implies for a Rust design
3. The systems-level techniques (zero-copy, io_uring, runtimes) and a concrete
   recommended architecture

---

## Part 1 — Protocol requirements (what the server must implement)

Source of truth: `PROTOCOL.md`. Full reference there; this is the implementation-shaping
summary.

### Resource model

- A **stream** is a URL-addressable, append-only byte sequence. Durable, immutable by
  position, strictly ordered. Has a content type fixed at creation (default
  `application/octet-stream`), optional sliding TTL or absolute expiry, and an explicit,
  durable, monotonic **closed** state.
- **Offsets** are opaque, lexicographically sortable, unique, strictly increasing
  strings (< 256 chars, no `, & = ? /`). Sentinels the server must never generate:
  `-1` (beginning) and `now` (current tail). Clients resume via the
  `Stream-Next-Offset` response header.

### HTTP surface

| Op               | Method                            | Key outcomes                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create           | `PUT {url}`                       | 201 new / 200 idempotent match / 409 config mismatch. Headers: `Content-Type`, `Stream-TTL` xor `Stream-Expires-At`, `Stream-Closed`, fork headers (`Stream-Forked-From`, `Stream-Fork-Offset`, `Stream-Fork-Sub-Offset`). Optional initial body.                                      |
| Append           | `POST {url}`                      | 200 new data / 204 duplicate or close-only / 409 closed, content-type mismatch, seq regression or gap / 403 stale producer epoch. Supports chunked bodies, `Stream-Seq`, atomic append+close via `Stream-Closed: true`.                                                                |
| Read (catch-up)  | `GET {url}?offset=O`              | 200 with bytes from O up to server-chosen chunk size. `Stream-Next-Offset` always; `Stream-Up-To-Date: true` when at tail; `Stream-Closed: true` only when client has reached the final offset. 410 if O before retention or stream soft-deleted.                                      |
| Read (long-poll) | `GET ...&live=long-poll&cursor=C` | Block until data, closure, or timeout. 200 with data, or 204 + `Stream-Up-To-Date` + `Stream-Cursor` on timeout. Closed-at-tail → immediate 204 + `Stream-Closed`, no wait.                                                                                                            |
| Read (SSE)       | `GET ...&live=sse`                | `text/event-stream`; `data` events (base64 for binary streams via `stream-sse-data-encoding: base64`; JSON batched as arrays) each followed by a `control` event (`streamNextOffset`, `streamCursor`, `upToDate`, `streamClosed`). Server SHOULD close ~every 60 s for CDN collapsing. |
| Metadata         | `HEAD {url}`                      | Tail offset, content type, TTL/expiry, closed flag. Must not reset TTL. Effectively non-cacheable.                                                                                                                                                                                     |
| Delete           | `DELETE {url}`                    | 204; if active forks exist → soft-delete (410 on direct ops, path blocked from recreation, data retained for forks, cascade cleanup when last fork dies).                                                                                                                              |

Plus a control plane under the reserved `__ds` prefix (subscriptions: webhook with
Ed25519-signed deliveries + JWKS, and pull-wake with claim/ack/release leases and
generation fencing). Routing for `__ds` must take precedence over stream paths.

### Idempotent producers (the exactly-once core)

Headers `Producer-Id` / `Producer-Epoch` / `Producer-Seq` (all or none). Per
(stream, producerId) the server keeps `{epoch, lastSeq}` and validates:

- `epoch < current` → 403 + current epoch (zombie fencing)
- `epoch > current` → must have `seq == 0` (else 400); accept and reset
- same epoch: `seq <= lastSeq` → 204 duplicate; `seq == lastSeq+1` → 200 accept;
  gap → 409 + `Producer-Expected-Seq`/`Producer-Received-Seq`

**MUST serialize validation + append per (stream, producerId)** so out-of-order
arrivals can't create false gaps. Ideally producer state commits atomically with the
data. Closure interacts: the closing (id, epoch, seq) is remembered so a retried
close is idempotent (204), anything else against a closed stream is 409.

### JSON mode (`application/json`)

- POST body that is an array is flattened one level; each element is one message.
  Empty array on POST → 400. Invalid JSON → 400.
- GET responses wrap messages in a JSON array — **the response body is not a raw byte
  range of what was POSTed**; the server adds `[ , ]` framing. (Big consequence for
  zero-copy; see Part 3.)

### Caching/CDN design baked into the protocol

- Catch-up 200s are cacheable (`public, max-age=60, stale-while-revalidate=300`),
  ETag = `{stream_id}:{start}:{end}` and must vary with closure status.
- Live modes carry an opaque `Stream-Cursor` (time-bucketed counter, 20 s intervals,
  monotonic with jitter) that the client echoes back, changing the cache key — this is
  what makes long-poll/SSE collapsible at a CDN without loops.
- `offset=now` catch-up returns immediately, empty, `no-store`.

### Easy-to-get-wrong conformance details

- Error precedence on append: closed → content-type mismatch → seq regression.
- New epoch must start at seq 0 (400 otherwise).
- `Stream-Up-To-Date` must be absent on partial (chunk-limited) responses.
- `Stream-Closed` only on the response that reaches the final offset.
- TTL resets on read/write, not HEAD; live-mode TTL resets when processing begins.
- Forks share the source's offset space, don't inherit producer state, may be created
  from closed streams (fork starts open), and have an inheritance table for TTL/expiry.
- SSE must defend against `data:` line injection (split on CR/LF/CRLF).
- Default port 4437.

---

## Part 2 — Existing server architectures (Go + TS) and lessons

### Shape (both implementations)

```
HTTP handler (method routing) → Store trait → { MemoryStore, FileStore }
```

Store operations: `create / get / has / delete / read(offset) / append /
wait_for_messages (long-poll) / close_stream(+with_producer) / current_offset`.

### File store on disk (Go caddy-plugin)

- **Data**: one append-only segment file per stream
  (`streams/{encoded_path}~{ts}~{rand}~log`), each message framed with a **4-byte BE
  length prefix**. Max message 64 MB.
- **Metadata**: bbolt KV (`metadata/metadata.db`), key = stream path, value = JSON
  `StreamMetadata` including the full per-producer map, closed state, fork refs.
- **Offsets**: `{readSeq:016}_{byteOffset:016}` — the byte offset is the physical
  position of payload bytes; lexicographic ordering falls out of zero-padding.
  `readSeq` is reserved for future log rotation (always 0 today).
- **Durability**: `file.Sync()` after every append; metadata written after data;
  recovery rescans segment files and treats the file as source of truth over bbolt.
- **Reads**: seek to byte offset, `bufio` 64 KB buffered read of each framed message
  into heap buffers, then concatenate (binary) or wrap in a JSON array. **No zero-copy
  anywhere.**
- **Long-poll**: per-path waiter registry of channels; every append/close notifies.
- **SSE**: poll loop (~100 ms) emitting data + control events; base64 for binary.
- **Concurrency**: global metadata RWMutex + per-(stream, producerId) locks; TS adds a
  per-stream append lock to serialize the offset read-modify-write. File-handle pool
  (SIEVE/LRU) caches open writers.
- **TTL**: lazy expiry check on access + optional background sweep.

### Lessons / inherited constraints for Rust

1. The **store-trait + memory/file backends** split is worth keeping — the conformance
   suite (`packages/server-conformance-tests`, driven by `CONFORMANCE_TEST_URL`
   against a plain HTTP base URL) is the validation harness, and a memory backend
   makes protocol work testable before the I/O engine is done.
2. **Per-append fsync** is the current durability contract; a Rust implementation can
   win big with group commit (batch appends → one fsync) without weakening semantics,
   since HTTP responses are only sent after the covering fsync completes.
3. The Go on-disk format (interleaved length prefixes) **forces copy-and-reassemble on
   every read**. This is the single biggest structural obstacle to zero-copy serving
   and the main thing to design differently (Part 3).
4. Producer dedup state lives with stream metadata and must survive restart; bbolt's
   role maps naturally to a small embedded KV or a metadata region per stream, but the
   data file must remain recoverable source of truth.
5. Long-poll/SSE fan-out is a per-stream subscriber list — trivially lock-free if
   streams are sharded to cores.

---

## Part 3 — Zero-copy + async-I/O design for the Rust server

### 3.0 The decisive design move: make the wire bytes contiguous on disk

The protocol's read responses are:

- **binary streams**: the concatenation of message payloads — no framing on the wire;
- **JSON streams**: `[` + payloads joined by `,` + `]`.

If the on-disk layout stores exactly the wire bytes contiguously, then **every
catch-up read is a literal byte range of a file** and can be served with
`sendfile(2)`/`IORING_OP_SPLICE` — zero userspace copies. So:

- **Data file**: payload bytes only, contiguous. For JSON streams, store each message
  followed by a `,` separator (the Go memory store already does the trailing-comma
  trick). A JSON read then becomes: `send("[", MSG_MORE)` → `sendfile(range minus the
final comma)` → `send("]")`. A binary read is headers + one `sendfile`.
- **Index file (or embedded index pages)**: message boundaries, append timestamps,
  whatever the server needs — kept _out_ of the data file so it never has to be
  stripped on the read path. Message-boundary lookup is needed to chunk responses on
  message boundaries (JSON) and to resolve fork sub-offsets.
- Offsets stay `{readSeq}_{byteOffset}` for compatibility, where byteOffset indexes
  the _payload_ byte space — which is now also the _file_ byte space. Free win.

Things that can never be zero-copy, by protocol design — don't contort for them:

- SSE data events (base64 for binary, `data:` line prefixes, JSON batching) — always
  encode through userspace. Fine: SSE batches are small and hot (page cache).
- Compressed responses (gzip negotiation), `ETag` computation, JSON validation of
  _incoming_ appends (must parse anyway), control events.

### 3.1 Linux zero-copy primitives — what applies where

| Primitive                            | Path                        | Verdict for this server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sendfile(2)`                        | file→socket                 | **The workhorse for catch-up reads and long-poll 200s.** In-kernel page-cache→socket; no TLS unless kTLS; write headers first with `send(..., MSG_MORE)` (no header iovecs on Linux, unlike FreeBSD). Can block on cold-file page faults → cap chunks (nginx uses 512 KB) and/or route cold reads off the hot path.                                                                                                                                                                                                                                                                            |
| `splice(2)` via pipe                 | socket→file                 | The zero-copy _append_ path: `splice(sock→pipe)`, `splice(pipe→file)`. `SPLICE_F_MOVE` is a no-op since 2.6.21 — what you really get is skb-page reference passing into the page-cache write path, i.e. "one less copy", not literally zero. Two syscalls per chunk ⇒ **only worth it for large bodies (≳64 KB / chunked uploads)**; for typical small appends, batching beats it. Available as `IORING_OP_SPLICE` (kernel 5.7+), so it can be expressed as linked SQEs with no syscalls.                                                                                                      |
| `copy_file_range(2)`                 | file→file                   | Not a network-path tool, but ideal for **fork materialization, segment compaction, retention trims** — reflink-capable on XFS/Btrfs (metadata-only copy).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MSG_ZEROCOPY` / `IORING_OP_SEND_ZC` | user-mem→socket             | Only relevant if bytes are in userspace (O_DIRECT designs). Pays off >~10 KB; SEND_ZC (kernel 6.0+, two-CQE model) is ~2× better than raw MSG_ZEROCOPY and +31–43 % vs epoll at 1.5–4 KB payloads on 6.11. Optional add-on, not the core.                                                                                                                                                                                                                                                                                                                                                      |
| kTLS                                 | TLS without losing sendfile | **The big unlock for HTTPS.** rustls handshake → `dangerous_extract_secrets()` → `setsockopt(TCP_ULP, "tls")` + `TLS_TX/TLS_RX`; then sendfile/splice keep working (kernel produces TLS records). The `ktls` crate (rustls org, v6.x) does exactly this for tokio-rustls, including the fiddly drain-at-record-boundary logic. Gotchas: handle control-message cmsgs on RX; TLS 1.3 KeyUpdate/rekey only handled on very recent kernels (~6.14) — disable or drop connection on KeyUpdate; AES-GCM/ChaCha20 suites. Kafka famously loses sendfile under TLS — kTLS is the chance to do better. |
| zcrx (io_uring zero-copy receive)    | socket→user-mem             | Kernel 6.15+, needs NIC queue steering. Not practical yet; ignore.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

macOS/BSD: `sendfile` exists on macOS (with header iovecs), no splice/kTLS/io_uring.
Keep a portable buffered fallback; treat zero-copy as a Linux-only fast path.

### 3.2 io_uring features worth using

- **Multishot accept + multishot recv with provided buffer rings** (5.19/6.0+): one
  SQE yields a stream of completions, and the kernel picks buffers from a shared pool —
  exactly what thousands of idle long-poll/SSE connections need (no buffer pinned per
  idle connection).
- **Registered files + fixed buffers**: skip per-op fd refcounting and page pinning on
  the file-I/O path.
- **Linked SQEs** (`IOSQE_IO_LINK`): express `recv → write → fsync → send(response)`
  or `splice(sock→pipe) → splice(pipe→file)` chains with ordering and zero syscalls.
- **`IORING_OP_FSYNC` / `sync_file_range`** for async group commit.
- **`IORING_SETUP_DEFER_TASKRUN` + `COOP_TASKRUN`** (6.0+): cheap latency wins.
- Skip **SQPOLL** (burns a core; only pays at saturation) and **IOPOLL/O_DIRECT**
  initially — see 3.4.
- Feature-gate by kernel at startup: baseline 5.15 (splice, registered buffers),
  5.19+ (buffer rings, multishot), 6.0/6.1 (SEND_ZC, DEFER_TASKRUN). Degrade
  gracefully to epoll-style readiness or plain buffered I/O.

### 3.3 Runtime choice

| Option             | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **compio**         | **Recommended.** Thread-per-core, completion-based, io_uring on Linux / IOCP on Windows / polling fallback on macOS (dev parity for free). Actively maintained, broadest current op coverage. Validated in anger by Apache Iggy — the closest prior art to this project (Rust persistent message streaming), which migrated tokio → thread-per-core io_uring and measured 56–60 % latency improvements across percentiles, +18 % throughput / −45 % P95 in fsync mode. |
| monoio (ByteDance) | Credible alternative with production mileage (ByteDance gateways, Monolake). io_uring-first, kqueue fallback. Iggy found feature parity/maintenance lacking for their needs.                                                                                                                                                                                                                                                                                           |
| glommio            | Deep io_uring (Seastar-like) but open "call for maintainers" — risky.                                                                                                                                                                                                                                                                                                                                                                                                  |
| tokio-uring        | Effectively stalled since ~2022. Avoid.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| plain tokio        | The safe fallback: buffered `pwritev` via blocking pool, chunked reads, hyper/axum. ~NATS JetStream level of I/O sophistication — fine, but forecloses the whole zero-copy agenda (hyper's Body forces bytes through userspace; no sendfile).                                                                                                                                                                                                                          |

Completion-based I/O means owned buffers; hyper/tower assume readiness + `&mut [u8]`,
so bridging costs copies or adapters. The Durable Streams HTTP surface is small
(5 methods, simple headers, SSE) — **write a minimal HTTP/1.1 + SSE layer directly on
the completion runtime**, which is also the only way to get sendfile under the
response path. Keep axum/hyper at most for an admin plane.

### 3.4 Page cache vs O_DIRECT

For a log service the dominant read is the **hot tail**: bytes appended milliseconds
ago, fanned out to N readers. With buffered writes those bytes are already in page
cache and `sendfile` serves all N readers from one cached copy with zero disk reads —
Kafka's whole design thesis ("consumers mostly caught up ⇒ no disk read activity at
all"). O_DIRECT (the Redpanda/Seastar/TigerBeetle road) means building your own cache,
readahead, and I/O scheduler. **Start buffered + page cache.** Revisit O_DIRECT only
if writeback stalls show up under sustained load. For cold catch-up reads, cap
sendfile chunk size (~512 KB, nginx's lesson) so one cold reader can't stall a shard.

### 3.5 Recommended architecture

**Thread-per-core, shard by stream.** One io_uring/executor per pinned core;
`hash(stream path) → shard`; SO_REUSEPORT listener per shard (re-route cross-shard
requests via lightweight message passing, Iggy's "shared-something": sharded data
plane, small shared control plane). All per-stream state — active segment fd, tail
offset, producer map, closed flag, long-poll/SSE subscriber list — lives on its shard
with **no locks at all**. The protocol's per-(stream, producerId) serialization
requirement becomes free: the shard is single-threaded.

**Write path (network→file):**

1. Multishot recv into provided buffer ring.
2. Parse headers; validate producer (in-shard state, no locks); JSON streams must be
   parsed anyway (validation + flattening), so JSON appends are inherently buffered —
   rewrite array elements as `elem,` runs into the data file.
3. **Group commit**: coalesce concurrent appends on the shard → one
   `pwritev`/`WRITE_FIXED` + one `IORING_OP_FSYNC` → complete all covered HTTP
   responses. Preserves the per-append durability contract with a fraction of the
   fsyncs. (Go does fsync-per-append; this is the largest easy throughput win.)
4. Size-gated fast path (later, profile-driven): bodies ≥64 KB on binary streams →
   linked `IORING_OP_SPLICE(sock→pipe)` + `SPLICE(pipe→file)`, skipping userspace
   entirely.
5. Metadata (producer state, tail, closed) journaled per group commit; data file is
   recovery source of truth, as in Go.

**Read path (file→network):**

1. Resolve offset → file range via the in-shard index (binary: any byte range; JSON:
   snap to message boundaries via index).
2. `send(status line + headers, MSG_MORE)` then `sendfile`/`IORING_OP_SPLICE` the
   range (minus trailing comma for JSON, then `send("]")`). Hot tail = page cache =
   zero disk I/O, shared across all readers.
3. Long-poll: park the request on the shard's per-stream waiter list (plain `Vec`,
   no sync); append/close/timeout wakes it; respond as in catch-up. Closed-at-tail →
   immediate 204, per spec.
4. SSE: buffered/encoded path by necessity (base64/`data:` framing); batch + flush per
   control event; close ~60 s for CDN collapsing.
5. Small responses (<10 KB), HEAD, errors: plain buffered send — zero-copy machinery
   loses below ~10 KB.

**TLS:** rustls handshake → kTLS data path (crib the `ktls` crate's secret-extraction
and record-boundary draining; it's tokio-flavored so expect adaptation work on a
completion runtime — precedent: the "tarweb" io_uring+kTLS Rust server). Always keep
(a) pure-rustls userspace fallback and (b) "TLS-terminating proxy in front" as
supported deployments, so kTLS is an optimization, not a dependency.

**Forks / retention:** `copy_file_range` (reflink on XFS/Btrfs) for any physical
materialization; otherwise serve inherited ranges by stitching sendfile ranges from
the source stream's file — soft-delete refcounting keeps the source file alive, which
maps perfectly to "keep the fd/file until refcount hits zero".

### 3.6 Where the time actually goes (priority order)

1. **Syscall/wakeup overhead per small op** → io_uring batching, multishot, linked
   SQEs. Biggest first-order win; matters more than memcpy for small messages.
2. **fsync policy** → group commit.
3. **TLS memcpy + crypto** → kTLS (and hardware offload where available).
4. **Payload memcpy** → sendfile/splice; only dominant ≥10–64 KB.
5. Allocator churn → buffer pools / provided buffer rings.

Zero-copy is _not_ worth it for: small appends (batching wins), responses <10 KB,
SSE, compressed responses, macOS dev paths. It is _decisively_ worth it for: catch-up
reads, hot-tail fan-out, large streaming uploads, and keeping all of that under HTTPS
via kTLS.

### 3.7 Suggested build order

1. Store trait + memory store + minimal HTTP/1.1 on compio → pass conformance suite
   (`CONFORMANCE_TEST_URL=http://localhost:4437 pnpm test:run`). Protocol correctness
   first; the suite is strict about headers, status codes, and offset formats.
2. File store with the **contiguous wire-byte layout + separate index**, buffered
   pwritev + group-commit fsync, recovery scan.
3. `sendfile` read path (plaintext), capped chunks, hot-tail fan-out.
4. io_uring depth: multishot recv + buffer rings, registered files/buffers, linked
   write→fsync chains.
5. kTLS (rustls handshake → TLS_TX/TLS_RX), with userspace-TLS fallback.
6. Profile-driven extras: splice append path for large bodies, SEND_ZC, sub-offset
   index tuning, background TTL sweep, `copy_file_range` compaction.

### Key sources

- Kernel docs: [TLS](https://docs.kernel.org/networking/tls.html) ·
  [TLS offload](https://docs.kernel.org/networking/tls-offload.html) ·
  [MSG_ZEROCOPY](https://docs.kernel.org/networking/msg_zerocopy.html)
- man pages: [sendfile(2)](https://man7.org/linux/man-pages/man2/sendfile.2.html) ·
  [splice(2)](https://man7.org/linux/man-pages/man2/splice.2.html) ·
  [copy_file_range(2)](https://man7.org/linux/man-pages/man2/copy_file_range.2.html) ·
  [io_uring_setup(2)](https://man7.org/linux/man-pages/man2/io_uring_setup.2.html)
- [LWN: io_uring zero-copy send](https://lwn.net/Articles/879724/) ·
  [LWN: multishot recv](https://lwn.net/Articles/899498/)
- [rustls/ktls crate](https://github.com/rustls/ktls) ·
  [tarweb: io_uring + kTLS + Rust](https://blog.habets.se/2025/04/io-uring-ktls-and-rust-for-zero-syscall-https-server.html)
- [Apache Iggy: thread-per-core io_uring migration](https://iggy.apache.org/blogs/2026/02/27/thread-per-core-io_uring/) —
  closest prior art, with numbers
- [compio](https://github.com/compio-rs/compio/) · [monoio](https://github.com/bytedance/monoio) ·
  [glommio maintainers issue](https://github.com/DataDog/glommio/issues/707)
- [Kafka design (sendfile + page cache)](https://kafka.apache.org/10/design/design/) ·
  [What makes Redpanda fast](https://www.redpanda.com/blog/what-makes-redpanda-fast) ·
  [TigerBeetle io_uring abstraction](https://tigerbeetle.com/blog/2022-11-23-a-friendly-abstraction-over-iouring-and-kqueue/) ·
  [nginx thread pools (9×)](https://www.f5.com/company/blog/nginx/thread-pools-boost-performance-9x)

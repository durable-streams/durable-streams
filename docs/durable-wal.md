# Durable WAL

The server acks an append only after the record is durable in a **sharded,
segmented, append-only write-ahead log**, giving **single-node no-loss durability +
clean recovery (no torn record, including torn JSON)** — while keeping the server's
zero-copy _read_ path byte-for-byte unchanged.

The WAL gives a durable, framed record boundary that lets an append ack **without**
a per-stream-file fsync on the hot path, yet recover _cleanly_ and _losslessly_ on
one node. Per-stream files are the read surface; the WAL is the durability surface.
Checkpoint periodically fsyncs per-stream files and recycles WAL segments.

```
durable-streams-server                          # WAL durability on by default
durable-streams-server --wal-shards 8           # override shard count (init only)
```

This document is the **as-built** reference: it cites the code on `vbalegas/wal-v2`
(HEAD `4a0e8c2f`) and calls out, throughout, where the build extended or deviated
from the design spec (`docs/superpowers/specs/2026-06-22-durable-wal-v2-design.md`).
The single largest as-built addition — **segment roll** plus the machinery it
forced (`sealed_pending`, per-stream durable-tails) — was added in a post-review
fix-wave; the spec assumed a single 128 MiB segment per shard.

## Architecture

### Write path

Every append writes the wire bytes to the per-stream data file (page cache, no
hot-path fsync — this is the read surface), then stages a framed record into the
stream's WAL shard (`maybe_sync_on_ack`, `src/handlers.rs:672`). The ack is held
until the shard's group-commit committer `fdatasync`s the segment covering the
record and advances its durable watermark.

**Reads are unchanged**: they serve from the per-stream contiguous file via the
existing `sendfile`/`Body::FileRange` path; the WAL is **never** a read surface
(read only by recovery). Tiering (`tier.rs` seal/offload to S3) is untouched,
downstream of the file.

### Module map

The WAL lives in `src/wal/` and is always active (`src/wal/mod.rs:1`).

| file           | responsibility                                                                             |
| -------------- | ------------------------------------------------------------------------------------------ |
| `codec.rs`     | B-light record framing (header CRC + optional payload CRC); torn-tail detection            |
| `segment.rs`   | `fallocate`'d segment files; `SegmentWriter` trait (io_uring drop-in seam); seal/roll      |
| `shard.rs`     | one shard: reserve/stage, group-commit committer, contiguous-written watermark, checkpoint |
| `walset.rs`    | the `N` shards; persisted-`N` FNV-1a routing; mismatch guard; committer spawn              |
| `recovery.rs`  | per-shard parallel replay → per-stream-file tail repair                                    |
| `telemetry.rs` | per-shard batch-size histogram + 1 Hz `WAL_STATS` emitter (`feature = telemetry`)          |

## Design

### Sharded WAL — persisted-N FNV-1a routing

The WAL is `N` independent segmented logs under `<data-dir>/wal/<i>/`, one
group-commit committer per shard, so `N` `fdatasync`s run in parallel. A stream
maps to **exactly one** shard via `shard = fnv1a(stream_id) % N`
(`src/wal/walset.rs:123`), applied to every record kind, so all of a stream's
records (and its Close/Delete) land in its one shard and the per-shard LSN sequence
totally orders that stream — no global LSN needed.

Two properties are load-bearing and both as-built:

- **Fixed FNV-1a, not `DefaultHasher`** (`src/wal/walset.rs:34`). `DefaultHasher`/
  `RandomState` are seeded per process, so they would route a stream to a different
  shard every boot. `fnv1a` is a fixed-constant 64-bit FNV-1a over
  `stream_id.to_le_bytes()` — pure, deterministic, identical across processes,
  builds, and architectures.
- **`N` is persisted, not recomputed per boot.** `N` is fixed at data-dir creation
  and written to `<data-dir>/wal/shards` (`SHARDS_FILE`, `src/wal/walset.rs:29`).
  `WalSet::open` (`src/wal/walset.rs:63`) reads it; `available_parallelism()` (the
  caller's `default_n`) is consulted **only** when first persisting a fresh data
  dir, never to route. `--wal-shards N` is honored only at init; on an existing
  data dir a value ≠ the persisted `N` returns `Err` (`src/wal/walset.rs:88`),
  which `main.rs` maps to **exit 2** (`src/main.rs:229`).

Default `N` = `std::thread::available_parallelism()` (`src/main.rs:181`), which on
Linux honors the cgroup `cpu.max` quota — so a pod capped at 4 CPUs gets 4 shards,
not the node's core count.

### Append data path

For each append (`maybe_sync_on_ack`, `src/handlers.rs:684`):

1. **Per-stream file write** — the wire bytes are written to the stream's own file
   (page cache, **no** hot-path fsync) by `write_wire` (`src/handlers.rs:724`),
   upstream of the helper. This is the read surface.
2. **Compute the logical `stream_offset`** — `wal_stream_offset`
   (`src/handlers.rs:658`) returns `Some(file_base + target − wire.len())`, the
   _logical_ pre-append offset, computed **under the appender lock** so a
   concurrent compaction can't desync `file_base` from `target`.
3. **Register dirty before staging** — `shard.register_dirty(st.id, st)`
   (`src/handlers.rs:706`) puts the stream in the shard's checkpoint dirty-set
   **before** the WAL record is staged. This ordering is required: once a record is
   staged its LSN can become durable and a concurrent checkpoint could recycle the
   WAL segment carrying it; if the stream were not yet dirty, that checkpoint would
   unlink the segment without having fsync'd the per-stream file — recycle-before-
   fsync loss (the CQ-1 fix).
4. **Stage the framed record** — `shard.reserve_and_stage(Append, st.id,
stream_offset, wire)` (`src/handlers.rs:712`) encodes a B-light record and
   `write_at`s it into the active segment.
5. **Ack gate** — `shard.wait_durable(lsn).await` (`src/handlers.rs:718`) blocks
   the ack until the committer's `durable_lsn` (the contiguous-written watermark)
   covers this LSN.

The payload reaches **two** files (per-stream + WAL) via one user-space buffer
(`wire`), written to both — the spec's deliberate "buffered double-write" v1 cut.
See [LIMITATIONS.md](../packages/server-rust/LIMITATIONS.md) for the planned
zero-copy upgrade path.

### B-light record framing

A record is a 38-byte fixed header + payload (`src/wal/codec.rs`, `HEADER_LEN = 38`, little-endian):

```
u32  len            // payload length
u32  header_crc32c   // crc32c over [lsn, kind, stream_id, stream_offset, len, flags, payload_crc]
u64  lsn            // monotonic WITHIN the shard (no global LSN)
u8   kind           // 1=Append 2=StreamCreate 3=StreamClose 4=StreamDelete
u64  stream_id
u64  stream_offset  // logical Stream-Next-Offset before this append
u8   flags          // bit 0 = PAYLOAD_CHECKSUMMED; other bits reserved (0)
u32  payload_crc32c  // crc32c over the payload, valid iff PAYLOAD_CHECKSUMMED set
[len bytes payload]
```

`header_crc` covers `[lsn, kind, stream_id, stream_offset, len, flags, payload_crc]` and is
computed identically by `encode_into` and `decode_at`, so they cannot diverge. The `flags`
and `payload_crc` fields are themselves integrity-protected by the header CRC. `decode_at` returns:

- `Record` — header CRC valid, kind known, all `len` payload bytes present, **and** — when
  `PAYLOAD_CHECKSUMMED` is set — `crc32c(payload) == payload_crc`.
- `Incomplete` — fewer than 38 bytes, or an **all-zero** header (a `fallocate`'d,
  never-written tail = the clean end of the durable log, not corruption).
- `Torn` — a present header that fails CRC, carries an unknown kind, whose payload is short,
  or whose payload CRC does not match (when the flag is set). The first such record ends the
  durable log.

**Buffered (default) path** (`encode_into`): always computes the payload `crc32c` and sets
`PAYLOAD_CHECKSUMMED`. This closes Bug #1 (torn-payload-zeros): WAL segments are
`fallocate`'d to full size, so "payload bytes are physically present" was trivially true even
after a crash left a valid header over a zeroed, never-fully-written payload. With the payload
CRC such a record now fails decode and is correctly treated as `Torn`.

**Zero-copy splice path** (`commit_splice_header`): writes `flags = 0` / `payload_crc = 0`
— the payload is never read into userspace, so it cannot be checksummed. These records keep
the old "bytes present = complete" behavior, retaining the Bug #1 torn-payload residual for
the `--zero-copy` path. Closing it for zero-copy would require a durable per-segment written
high-water mark (recovery refuses to scan past it; costs +1 `fdatasync` per group-commit) —
a noted future option, not done here.

As-built note: only `Append` records are actually staged today
(`src/handlers.rs:713`); `StreamCreate`/`Close`/`Delete` discriminants exist in the
codec but stream identity is owned by the sidecar pass, so the WAL does not log
them (a documented v1 scope cut — recovery re-applies existing ids, never allocates
them).

### Segments, roll, and the `sealed_pending` window (as-built, post-review)

Each shard's log is a sequence of segment files `<shard_dir>/<start_lsn>.wal`
(`seg_path`, `src/wal/segment.rs:26`), each pre-allocated to a fixed
`SEGMENT_BYTES = 128 MiB` (`src/wal/segment.rs:22`) by `FileSegment::create`
(`src/wal/segment.rs:59`): `fallocate` on Linux, `set_len` on macOS. Because every
append lands in already-allocated space (no inode-size change), a plain
`fdatasync` makes a write durable — no metadata flush.

> **The biggest as-built addition.** The spec described a single segment per shard.
> The whole-branch review found this a **BLOCKER**: with one 128 MiB segment that
> Task-6 recycle could never free (the active segment is never recycled), the WAL
> would fill in ~40 s under bench load, and writes past the `fallocate`'d region
> would grow the inode while the committer only `fdatasync`s (not `fsync`s) — so a
> torn size on crash could re-expose a zero tail = **acked-record loss**. The
> fix-wave (commits `63e98fd..f40a691`) added **segment roll**, which is what makes
> recycle functional and gives bounded steady-state WAL disk.

**Roll** (`reserve_and_stage`, `src/wal/shard.rs:349`): if a record would overflow
the active segment, the appender (under the short reserve lock):

1. **Seals** the current segment — `seal_to(write_pos)` (`src/wal/segment.rs:95`)
   truncates it to **exactly** its packed size (dropping the `fallocate`'d zero
   tail) and `fsync`s (not just `fdatasync`, because the truncate changes the inode
   size). Exact packing is what lets recovery walk across the segment seam without
   seeing a zero gap.
2. Pushes `(end_lsn, sealed_segment)` onto `sealed_pending` (`src/wal/shard.rs:74`).
3. Opens a fresh full-size segment named for the rolling record's LSN and resets
   `write_pos`.

**`sealed_pending`** closes a subtle window that off-lock writes open: an appender
reserves its byte range in the old segment under the lock, but runs its `write_at`
_off-lock_; a concurrent roll can seal that segment **before** the late `write_at`
lands. The roll's own seal-fsync happened before those bytes, so it does not cover
them. The committer therefore `fdatasync`s **every** pending sealed segment plus
the active one before advancing `durable_lsn` (`src/wal/shard.rs:840`), and prunes
a sealed entry only **after** the fsync that covered it
(`src/wal/shard.rs:886`). This is the off-lock-write-after-seal fix; without it the
committer could publish `durable_lsn` past a record whose bytes in a sealed segment
were never fsync'd.

### Committer — continuous group commit, contiguous watermark

Each shard runs one `run_committer` task (`src/wal/shard.rs:825`): park on a
`Notify`, snapshot the watermark, `fdatasync` (sealed segments first, then active),
advance `durable_lsn` to the snapshot, publish via a `watch`, and immediately loop
(no idle timer) so a watermark that grew during the fsync is picked up at once. The
batch = records written during the in-flight fsync; it grows with offered load.

The durability invariant is the **contiguous-written watermark** (`ShardInner`,
`src/wal/shard.rs:45`). Appenders run two phases: a short locked **reserve**
(assign `lsn` + byte range, bump `next_lsn`/`write_pos`) and an off-lock
**stage** (`encode_into` + `write_at`, then `mark_written`). Because staging is
off-lock, LSN `k+1` can finish before `k`. `mark_written` (`src/wal/shard.rs:90`)
inserts the LSN into a `BTreeSet` and collapses `written_high` forward only across
a contiguous prefix — a reserved-but-never-written gap (a crashed appender, or the
test `reserve_only` hook) blocks the cursor permanently. The committer publishes
the **pre-fsync** snapshot exactly (`src/wal/shard.rs:861`), never re-snapshotting,
so it can never advance past a record the fsync did not cover. On any fsync error
it does **not** advance and does **not** ack (`src/wal/shard.rs:892`). A failed
`write_at` returns `Err` (the ack fails) rather than panicking
(`src/wal/shard.rs:404`) — the `reserve_and_stage → Result` fix-wave change; the
reserved LSN stays a permanent gap.

> **As-built:** the spec's Task-3 left `write_at` as `.expect()` (panic on write
> error). The fix-wave changed `reserve_and_stage` to return `io::Result<u64>` and
> propagate the error, matching the committer's fail-loud-don't-ack discipline.

### Checkpoint — dirty-set, batched fsync, durable-tails, recycle

`Shard::checkpoint` (`src/wal/shard.rs:451`), driven by a 3 s ticker
(`CHECKPOINT_INTERVAL`, `src/main.rs:279`; `spawn_checkpoint_ticker`,
`src/main.rs:287`), is the per-stream fsync _relocated off the ack path_, batched
and N-way parallel. Its **hard ordering**:

1. Snapshot `checkpoint_lsn = durable_lsn` (`src/wal/shard.rs:453`).
2. **Drain the dirty set** — `dirty: HashMap<stream_id, Arc<StreamState>>`
   (`src/wal/shard.rs:123`), deduped by id. `std::mem::take` it, read each stream's
   current logical `Shared.tail` and `Shared.file`, then `fdatasync` each file in a
   `spawn_blocking` task so a slow disk can't stall the runtime
   (`src/wal/shard.rs:465`). Draining first means a concurrent re-touch lands in the
   _next_ checkpoint, never silently dropped.
3. **Persist per-stream durable-tails** — `persist_durable_tails`
   (`src/wal/shard.rs:529`) merges each touched stream's durable tail into the
   cumulative `<shard_dir>/tails` map (`TAILS_FILE`, `src/wal/shard.rs:160`),
   `tmp`+rename, **fsync'd before recycle**.
4. **Persist `checkpoint_lsn`** to `<shard_dir>/checkpoint` (`tmp`+rename,
   `src/wal/shard.rs:505`).
5. **Recycle** — `recycle_below` (`src/wal/shard.rs:589`) unlinks every segment
   whose entire LSN range is below the floor, never the active segment.

Steps 2–4 run **strictly before** step 5: until a stream's bytes are fsync'd into
its own file and its durable boundary is recorded, the WAL is the only durable
copy. Checkpoint is **non-blocking**: acks gate on `durable_lsn` (`wait_durable`),
never on checkpoint, so a stalled checkpoint only delays WAL recycling (a disk-
bounded backpressure, not v1's memory bound). A failed checkpoint is logged, not
fatal (`src/main.rs:296`); a failed unlink leaves over-retention, never loss
(`src/wal/shard.rs:624`), and the next checkpoint retries.

> **As-built:** per-stream durable-tails (step 3) were **not** in the spec's
> checkpoint. The fix-wave (Task 11b, commit `c3f2374`) added them because once
> recycle actually fires (the roll era), a stream whose durable WAL records are all
> recycled but which carries a torn page-cache tail in its per-stream file has no
> surviving WAL boundary to truncate to. The persisted tail is that boundary. This
> also changed the dirty-set value type from a bare `Arc<File>` (spec) to
> `Arc<StreamState>` so checkpoint can read the logical tail it records.

### Recovery — replay-from-oldest, file_base mapping, torn-tail repair

WAL recovery (`recovery::recover`, `src/wal/recovery.rs:69`) runs at boot **after**
the non-sharded sidecar pass that owns stream identity (`Store::recover` inside
`new_with_tier`, `src/store.rs:476`) and **before** any append. It builds a
`stream_id → Arc<StreamState>` index from the sidecar-recovered streams, then
spawns one OS thread per shard (`src/wal/recovery.rs:86`) — shards own disjoint
stream sets, so replay is N-way parallel with no synchronization. It **only repairs
file-tail bytes**; it never allocates ids or creates/deletes streams.

Per shard (`recover_shard`, `src/wal/recovery.rs:96`):

- **Replay from the oldest _retained_ record, not from `checkpoint_lsn`**
  (`replay_from_checkpoint(0, ...)`, `src/wal/recovery.rs:143`). This is the **C1
  torn-JSON structural fix**: a stream whose last durable record is ≤ checkpoint can
  still carry a torn page-cache tail in its per-stream file (bytes written on the
  hot path before the WAL ack, then a crash); replaying only from `checkpoint_lsn`
  would leave its frontier empty and re-expose the torn tail. `checkpoint_lsn` is
  read (`src/wal/recovery.rs:131`) but used only as a write-skip optimization — the
  bound is `0`.
- **Seed the frontier from the persisted durable-tails** (`read_durable_tails`,
  `src/wal/recovery.rs:138`), so a stream whose WAL records were all recycled is
  still reconciled (the roll-era hole).
- For each `Append`, resolve `stream_id → StreamState`; **frontier skip** if
  `stream_offset < file_base` (`src/wal/recovery.rs:159`) — those bytes are already
  sealed/offloaded into a chunk, so re-applying would be out of range. Otherwise
  write the payload at `file_pos = stream_offset − file_base`
  (`src/wal/recovery.rs:162`) and raise the stream's frontier to
  `max(frontier, stream_offset + len)`. A record for a `stream_id` with no
  `StreamState` (deleted) is skipped.
- **Reconcile each touched stream's tail** to `durable_frontier =
max(persisted_tail, replayed)` (`reconcile_tail`, `src/wal/recovery.rs:234`):
  if the file is **longer** than the frontier, truncate the un-acked torn tail to
  the whole-record boundary (`set_len`); if **shorter**, the replay writes already
  extended it. Then **`fdatasync` the repair** (`src/wal/recovery.rs:256`) so a
  crash after recovery but before the next checkpoint can't lose it, and publish
  `Shared.tail` + the appender `written`.

After recovery, `reset_after_recovery` (`src/wal/walset.rs:139`,
`src/wal/shard.rs:249`) wipes each shard's WAL to a fresh zero-filled segment at
LSN 1 (and removes the stale `checkpoint`/`tails` files). This closes the
**recover-before-clobber** hole: `Shard::open` is non-destructive (it keeps the
pre-crash bytes for recovery to read) but resets the in-memory cursor to LSN 1 /
offset 0, so without the wipe the live appenders would write a possibly-shorter
record over the old segment and leave a stale suffix of whole framed records a
_second_ crash would mis-replay. The boot order (`src/main.rs:222`) is exactly:
`WalSet::open` (non-destructive) → `recovery::recover` → `reset_after_recovery` →
`store.wal.set` (attach, lock-free `OnceLock`) → `spawn_committers` → checkpoint
ticker → emitter → serve.

### Durability primitive — `F_FULLFSYNC` on macOS

Both the committer's `fdatasync` (`FileSegment::fdatasync`, `src/wal/segment.rs:154`)
and the seal's `fsync` (`seal_to`, `src/wal/segment.rs:95`) use **macOS
`F_FULLFSYNC`** (a true flush-to-platter, power-loss durable) with a plain `fsync`
fallback, and **Linux `fdatasync`/`fsync`**.

> **As-built, final commit.** The fix-wave initially used the macOS
> `F_BARRIERFSYNC`-first ladder (a write barrier, _not_ power-loss durable),
> matching a project-wide convention. The final WAL commit (`4a0e8c2f`) dropped it:
> a WAL whose contract is "single-node no-loss" must be truly power-loss durable, so
> all three macOS ladders are now `F_FULLFSYNC`. Linux `fdatasync`/`fsync` is
> byte-for-byte unchanged (bench-safe).

### Telemetry — per-shard batch-size distribution

The headline signal is **records-per-`fdatasync`**, recorded once per successful
commit by `ShardStats::record_batch(watermark − durable)` (`src/wal/shard.rs:877`,
`src/wal/telemetry.rs:91`) — a handful of relaxed atomic adds plus one bucketed
`fetch_add` (buckets `[1,2,4,8,16,32,64,128]`, `src/wal/telemetry.rs:50`), no lock/
alloc/syscall on the commit path. A 1 Hz emitter (`spawn_emitter`,
`src/wal/telemetry.rs:240`) prints `WAL_STATS shard=<i> batch_p50/p99/max/avg
last_batch fsync_count tail_lsn durable_lsn checkpoint_lsn size_bytes segments`
per shard plus an aggregate line; `size_bytes`/`segments` come from a `read_dir`
**only in the emitter**, never the commit path (CQ-2). The emitter is
**`feature = telemetry`-gated** — with the feature off it is a no-op
(`src/wal/telemetry.rs:319`), so a default build pays only the per-commit atomics.

### io_uring committer for WAL — deferred to follow-up

An io_uring WAL committer (per-shard ring + dedicated thread, batching writes and
`fdatasync`) was prototyped but **deferred from the initial io_uring merge.** A GKE
A/B showed it trades CPU for throughput on the WAL path (~+83 CPU points,
CPU-per-append +5.6%, alongside +37% throughput and −17 ms p99) versus the sync
committer — because each shard's committer thread busy-spins in its
process-more-first loop and every record's write is handed off through the ring.
The fix (bounded park instead of pure spin, and/or fewer committer threads /
fsync-only routing) is tracked as follow-up #1 in
`docs/superpowers/durability-performance-followups.md`; the design is preserved in
`docs/superpowers/specs/2026-06-23-wal-io-uring-writes-design.md`. Until the
follow-up lands, the WAL path uses the sync `pwrite` + `spawn_blocking` committer
described above.

### `SegmentWriter` — the sync I/O seam

`SegmentWriter` (`src/wal/segment.rs:35`) abstracts a shard's WAL I/O down to two
calls — `write_at` and `fdatasync`. The default `FileSegment` impl uses ordinary
positioned syscalls (`pwrite` loop + `F_FULLFSYNC`/`fdatasync`). It is the seam a
future io_uring WAL committer would build on (see io_uring committer section above).

## Performance insights

Measured on a single machine (Mac, `F_FULLFSYNC`, 4 shards). The mechanism, not
just the numbers, is the point: the WAL does **few fat per-shard fsyncs** instead
of one per stream. That advantage grows with stream cardinality.

### Fixed-concurrency cardinality sweep (conc = 64)

| streams | ops/s        |
| ------- | ------------ |
| 10      | ~1,300–1,600 |
| 100     | ~1,300–1,600 |
| 1,000   | ~1,300–1,600 |
| 10,000  | ~1,300–1,600 |

The WAL is **flat ~1,300–1,600 across all cardinalities**: its batching is
**global per shard**, not per stream, so it is cardinality-_insensitive_ — the
committer folds whatever is in flight into one fsync regardless of how the load is
spread across streams.

### Higher concurrency (conc = 256)

At conc = 256 the WAL's fat-batch advantage compounds further: no append blocks on
a per-stream barrier; it waits only for the next shared shard commit, which is
already in flight.

### The honest nuance

At very low stream counts (≤ ~10) the WAL still pays a committer hop (stage →
notify → wait on the shard's `durable_lsn` watch). The win is in the **realistic
regime** — `conns/stream ≪ 1`: many streams, few concurrent writers each.

**Caveat — the 100k local wall.** Pushing to 100k streams locally hit the macOS
`kern.maxfilesperproc` fd cap (one open file per stream). It bounds the local box,
not the WAL design; Linux/GKE with a raised `nofile` clears it.

## Spec-adherence audit

Verified against the code on `vbalegas/wal-v2` (`4a0e8c2f`).

| #   | spec optimization                                          | verdict               | evidence                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Zero-copy reads unchanged; WAL never a read surface        | **HOLDS**             | The server serves from the per-stream file (`sendfile`/`FileRange`); the WAL is read only by `recovery.rs`. The read path is untouched.                                                                                                                                                                |
| 2   | No in-memory tail / no materializer / no read-from-WAL     | **HOLDS**             | The per-stream file _is_ the applied view; the WAL stages framed records and is replayed only at boot. There is no in-memory un-materialized tail at all.                                                                                                                                              |
| 3   | Batched group commit, N parallel committers                | **HOLDS**             | One `run_committer` per shard (`spawn_committers`, `src/wal/walset.rs:147`); each fat-batches a fsync; the cardinality sweep confirms cardinality-insensitive batching.                                                                                                                                |
| 4   | WAL-only ack; `stream_offset` computed under appender lock | **HOLDS** (after fix) | The whole-branch review caught a regression — `stream_offset` was computed (taking `st.shared.read()`) unconditionally; the fix-wave moved it into `wal_stream_offset` (`src/handlers.rs:668`). Now verified.                                                                                          |
| 5   | Single-node no-loss + clean recovery (no torn JSON)        | **HOLDS**             | Committer never acks past the durable contiguous watermark; recovery replays-from-oldest + truncates the torn tail to a whole-record boundary + fsyncs the repair (C1 fix). 9 e2e tests over the real HTTP path, incl. ≥2-shard no-loss and no-torn-JSON.                                              |
| 6   | io_uring write+fsync committer for WAL (`--wal-io-uring`)  | **DEFERRED**          | Prototyped but dropped from the initial io_uring merge: a GKE A/B showed it trades CPU for throughput on the WAL path (committer threads busy-spin; per-record writes routed through the ring). Tracked as follow-up #1 (bounded-park / fewer-threads / fsync-only fix); design preserved in the spec. |
| 7   | Persisted-N, FNV-1a routing, mismatch → exit 2             | **HOLDS**             | `src/wal/walset.rs:34/88/123`; `src/main.rs:229`. N stable across reopen with a different `available_parallelism`.                                                                                                                                                                                     |

### Where the build extended the spec (as-built additions)

- **Segment roll + `sealed_pending`** (`src/wal/shard.rs:349/74/840`) — not in the
  spec (single-segment assumption); added in the fix-wave to make recycle functional
  and bound WAL disk, and to close the off-lock-write-after-seal loss window.
- **Per-stream durable-tails at checkpoint** (`src/wal/shard.rs:529`,
  `TAILS_FILE`) — not in the spec's checkpoint; required once recycle fires so a
  fully-recycled stream's torn tail can still be truncated. Changed the dirty-set
  value to `Arc<StreamState>`.
- **`F_FULLFSYNC` on macOS** (`src/wal/segment.rs`) — the spec named Linux
  `fdatasync` only; the build made macOS truly power-loss durable to honor the
  "no-loss" contract.
- **`reserve_and_stage → io::Result`** (`src/wal/shard.rs:305`) — a transient WAL
  write fails the ack instead of panicking (the spec/Task-3 used `.expect()`).

### Where the measured result relates to the spec's success criteria

Spec §14 set falsifiable throughput bars. The WAL delivers its stated purpose:
flat, cardinality-insensitive throughput at moderate-to-high stream counts, with
better p99 than a per-stream-fsync approach. At very low cardinality (≤ ~10
streams) the committer hop adds a real per-op tax — the WAL's win is in the
realistic regime (`conns/stream ≪ 1`) where per-stream coalescing would break down.

## Known deviations / caveats

- **`StreamCreate`/`Close`/`Delete` not WAL-logged** — only `Append` is staged;
  stream identity is reconstructed by the sidecar pass. Documented v1 scope cut.
- Deferred speed-ups (io_uring `SegmentWriter`, zero-copy double-write, CPU pinning,
  dynamic rebalancing, replication, checkpoint-cadence tuning) are tracked in
  `docs/superpowers/durability-performance-followups.md`. Payload CRC is now
  implemented for the buffered (default) path (optional, flag-gated per record;
  closes Bug #1 for that path). The zero-copy splice path still relies on
  header-only completeness — a durable written high-water mark (+1 `fdatasync` per
  group-commit) would be the mechanism to cover it there.

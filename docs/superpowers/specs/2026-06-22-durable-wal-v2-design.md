# Durable WAL (`--durability wal`) — Design Spec (v2)

> **As-built reference:** this is the pre-implementation design. For what was
> actually built (segment roll, `sealed_pending`, per-stream durable-tails,
> `F_FULLFSYNC`, measured numbers, and deviations from this spec), see
> [`docs/durable-wal.md`](../../durable-wal.md).

**Repo:** `durable-streams` · **Branch:** `vbalegas/wal-v2` (off `vbalegas/relaxed-durability` @ `pre-wal-v2`)
**Crate:** `packages/server-rust` · **Date:** 2026-06-22
**Follow-ups (deferred speed-ups):** `docs/superpowers/durability-performance-followups.md`

**Goal:** A third durability mode, `--durability wal`, backed by a **sharded
(per-CPU), segmented, append-only write-ahead log** that gives **single-node no-loss
durability + clean recovery (no torn records, incl. JSON)** — keeping the server's
zero-copy _read_ path exactly as today, with **N parallel committers** so it doesn't
re-create v1's serial-fsync ceiling, and **no in-memory tail / no materializer** so it
can't re-create v1's backpressure collapse.

## 1. Why (insights from the experiments)

- The "cardinality fsync wall" was a multi-pod dedup **measurement artifact**;
  `strict`'s parallel per-stream `fdatasync` scales to 10k streams (~40k ops/s) on NVMe.
- `relaxed` (now `fast`) is faster at low–moderate cardinality with better tails, but
  gives **no local durability** and can recover a **torn trailing JSON record** after an
  OS crash (C1: un-fsynced per-stream file, page-granular writeback stops mid-record, no
  durable record boundary to trim to).
- **The WAL's value: a durable, framed record boundary** that lets an append ack without
  a per-stream-file fsync yet recover _cleanly_ and _losslessly_ on one node.
- WAL v1 died from a **copy-heavy materialize-back path**: data → WAL **+** an in-memory
  un-materialized tail (512 MiB ceiling → backpressure → collapse ~500 ops/s); a single
  serialized committer **starved** by that backpressure (batch ≈14); a materializer
  crawling at ~40 rec/s. Even with **all** fsync removed it still collapsed → the **data
  path, not fsync, was the wall.** v2 deletes that path and parallelizes the fsync.

## 2. The three durability modes

`--durability strict|wal|fast` (default `strict`). Mutually-exclusive **backends** behind
a `DurabilitySink` trait. `relaxed` is **renamed `fast`** (no deployed consumer).

| mode               | mechanism                                                                                    | crash guarantee                                                    |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `strict` (default) | per-stream file, `fdatasync` before ack — **no WAL**                                         | no-loss. **Byte-for-byte today's `strict`.**                       |
| `wal`              | per-stream file (page cache, no hot fsync) **+** sharded WAL, batched `fdatasync` before ack | **single-node no-loss + clean recovery (no torn record)**          |
| `fast`             | per-stream file, **no** explicit fsync (today's `relaxed`)                                   | lossy tail; can torn JSON. Replication builds on this path, later. |

`strict`/`fast` are exactly the existing per-stream-file paths (one renamed); **reads are
unchanged in all three modes.** `wal` adds, on the append path, a buffered write of the
payload into a per-shard WAL + a batched per-shard WAL fsync.

## 3. Architecture (textbook WAL, sharded: durable log + applied page view)

- **Per-stream contiguous files** — the **applied view and the only read surface**, raw
  wire bytes as today. In `wal` mode written on the hot path (page cache, _no_ per-append
  fsync), made durable in batches at checkpoint.
- **Sharded WAL** — `N` independent segmented logs under `<data-dir>/wal/<shard>/`, each
  `fdatasync`'d before ack by its own committer. **Never read on the serving path** —
  read only by recovery. `N` is fixed at data-dir init and persisted (§5).
- **Per-CPU committers** — one per shard; each group-commits + `fdatasync`s its segment.
  **N run in parallel → N parallel `fdatasync`s.**
- **Checkpoint** (per shard) — batched `fdatasync` of that shard's touched per-stream
  files, then recycle that shard's WAL segments below its checkpoint. **No materializer /
  no compactor** — the per-stream files already hold the data; checkpoint only _fsyncs_.
- **`SegmentWriter`** — abstraction over a shard's WAL I/O (header write + payload write +
  `fdatasync`). Default impl = ordinary syscalls; io_uring impl is a drop-in later (the
  committer's fsync **also** goes through it, so io_uring is a true drop-in).

**Data path (v1 cut — buffered, honest):** an append's payload must reach **two** files
(per-stream + WAL), and a socket payload can be `splice`d only **once** — so in `wal`
mode the payload is held in a user buffer (the request-body `Bytes`) and `write()`-en to
both. **`--splice-appends` is a no-op under `wal` (v1).** This is one cheap user-space
copy per record (memcpy ≈10 GB/s; the `--no-fsync` experiment proved copies were never
the wall — fsync was). **Reads stay 100% zero-copy** (`sendfile` from the per-stream
file). Restoring write-path zero-copy (`tee`+`splice` / `copy_file_range` / io_uring) is
follow-up #1/#3, behind `SegmentWriter`.

## 4. WAL record format (B-light — framing without payload CRC)

Per-shard segment `<data-dir>/wal/<shard>/<start_lsn>.wal`, **`fallocate`d to full size**
(in-place appends ⇒ no inode-size change ⇒ `fdatasync` suffices, sequential writes):

```
record = {
  u32  len            // payload length
  u32  header_crc32c   // crc32c over [lsn, kind, stream_id, stream_offset, len]
  u64  lsn            // monotonic WITHIN THE SHARD (no global LSN — §5)
  u8   kind           // 1=Append 2=StreamCreate 3=StreamClose 4=StreamDelete
  u64  stream_id      // stable per-stream id
  u64  stream_offset  // logical Stream-Next-Offset BEFORE this append
  [len bytes payload]
}
```

- **Torn-tail detection:** a record is complete iff `header_crc` validates **and** the
  segment holds `len` payload bytes after the header. First failure ends the durable log.
  Torn-tail-safe **without** payload CRC — same integrity as today's per-stream files (no
  CRC). No payload bit-rot detection (follow-up #7).
- **No-loss despite page-granular writeback:** the committer `fdatasync`s before advancing
  its `durable_lsn`; `fdatasync` forces all of that shard's pages to disk → no holes below
  `durable_lsn`. Acked data recovers completely; only the un-acked tail can be torn (and
  is discarded).

## 5. Sharding (per-CPU, fixed allocation)

- **`N` shards**, fixed at data-dir creation and **persisted** (`<data-dir>/wal/shards`).
  A stream's shard is computed **only** from the persisted `N` and the record's
  `stream_id` — **never** from per-boot `available_parallelism` — so a stream resolves to
  the same shard across restarts and different-core machines. `--wal-shards` is honored
  only at init; on an existing data dir a value ≠ the persisted `N` is **rejected**
  (exit 2). Default `N` = core count at init.
- **Fixed allocation:** `shard = hash(stream_id) % N`, applied to **every record kind** —
  `Append`/`StreamCreate`/`StreamClose`/`StreamDelete` all carry the same `stream_id`, so
  all of a stream's records land in its **one** shard and a Close/Delete can never land in
  a different shard than the appends it must order after. No rebalancing, no cross-shard
  coordination.
- **Per-stream order is preserved with no global LSN:** a stream lives in exactly one
  shard, so its per-shard lsn sequence totally orders it. Streams are independent — no
  cross-stream total order is needed.
- **Everything parallelizes per shard:** committers (§6), checkpoint fsync (§7), and
  recovery (§9) are N-way parallel. The per-stream `file_base`/tiering mapping (§9) is
  per-stream, unaffected by sharding.
- **Tradeoff — load skew:** hashing balances _streams_, not _load_; a few hot streams can
  pile on one shard. Accepted for fixed allocation; per-shard batch telemetry (§11)
  surfaces it; dynamic rebalancing is follow-up #5. CPU pinning is follow-up #4.

## 6. Committers (per-shard, continuous group commit, N parallel)

Each shard has one committer task: `notified().await` → `fdatasync` its active segment
(via `SegmentWriter`) → advance its `durable_lsn` → wake its appenders (`durable_lsn`
watch). The shard's **batch** = records written during its in-flight fsync; with no
in-memory-tail throttle it grows with that shard's load. **Aggregate throughput ≈ N ×
(batch × fsync_rate).**

- **Ordering with off-lock writes:** within a shard, completion order may differ from lsn
  order, so the committer advances `durable_lsn` only to the highest **contiguous
  fully-written** lsn (a written-watermark appenders advance as the prefix fills) — never
  the highest _assigned_ lsn. A record acks durable only after its own **and all prior
  in-shard records'** bytes are on disk and fsync'd.
- This watermark gates **durability/ack only.** A record's **readability** is gated
  separately by the per-stream file `tail` (advanced by `write_wire` under the appender
  lock, in order) — so a reader never sees a reserved-but-unwritten range regardless.
- On segment roll, `fdatasync` the closing segment before `durable_lsn` passes it. **fsync
  error ⇒ never advance `durable_lsn`, never ack.**

**Why this should match/beat `strict` (the C-2 resolution, argued not hand-waved):** v1's
batch stayed at 14 because the materializer **starved its input**, not because a committer
can't batch — remove the starvation (no in-memory tail) and group commit batches like any
DB WAL. With **N parallel** committers each issuing **few, fat** `fdatasync`s, the WAL does
far fewer device barriers than `strict`'s **many thin** per-stream fsyncs at high
cardinality — so `wal` has a real shot at _beating_ `strict` there, not just tying. **This
is verified by the per-shard batch telemetry (§11), not assumed:** small batches under
load ⇒ raise `N` / investigate skew.

## 7. Checkpoint + WAL retention (per-shard, non-blocking)

Per shard, per segment-roll or interval: one **batched** `fdatasync` over that shard's
per-stream files touched since its last checkpoint, persist its `checkpoint_lsn`, then
**recycle its WAL segments fully below `checkpoint_lsn`**. The per-stream-file fsync is
here — **off the ack path** (acks gate on the committer's `durable_lsn`, not checkpoint),
**N-way parallel**, amortized per checkpoint.

**Honest characterization (Important-3):** this is the per-stream fsync **relocated, not
removed** — a checkpoint still `fdatasync`s its touched files (~`10k/N` at 10k streams),
now async, batched, and **N-way parallel** instead of `strict`'s synchronous per-_append_
fsync. A lagging checkpoint does **not** backpressure appends via memory (there is none);
it only delays WAL recycling → the shard's WAL grows on disk until a **disk-size safety
valve** throttles (a _disk-bounded_ backpressure, far above v1's memory bound). Recycle
cadence is the tunable (follow-up #9). So success-criterion 3's "`append_block_ns` ≈ 0" is
conditioned on checkpoint keeping up — which sharding makes N× easier.

## 8. Read path — unchanged

`strict`, `fast`, and `wal` all serve reads from the per-stream contiguous file via the
existing `sendfile`/`Body::FileRange` path (one syscall per contiguous range; JSON
`[range-minus-trailing-comma]` reconstruction intact). The WAL is **not** a read surface.
Tiering (`tier.rs` seal/offload to S3) is unchanged, downstream of the file.

## 9. Recovery (`wal` mode), per-shard parallel, O(uncompacted tail)

Replay each shard's WAL **in parallel**. Per shard, from its `checkpoint_lsn` to its first
torn record (§4), re-apply records to **repair each stream's per-stream-file tail to the
durable frontier**:

- **Logical→file mapping (Important-2):** the record's `stream_offset` is _logical_; the
  live file starts at `Shared::file_base` (which tiering/compaction advances as it reclaims
  the sealed prefix). So recovery loads each stream's durable `file_base` from its sidecar
  `.meta` and writes WAL payloads at `file_pos = stream_offset − file_base`.
- **WAL × compaction frontier invariant:** a WAL record whose `stream_offset < file_base`
  has already been sealed/offloaded — recovery **skips** it (re-applying would be out of
  range / a double-apply); the skip is safe because those bytes live durably in a sealed
  chunk file. Conversely, **a WAL segment must not be recycled until its records'
  per-stream-file bytes are checkpoint-fsynced** (§7), and **compaction must not advance
  `file_base` past data whose only durable copy is still in the WAL.** The latter is
  **already provided by the existing seal→compact ordering** — `seal` `fsync`s the sealed
  bytes into a chunk file _before_ `sealed_offset` (hence `file_base`) advances past them
  (`tier.rs`), so any byte `file_base` has passed is durable in a chunk independent of the
  WAL; no new enforcement at the compaction site is required.
- **WAL replay vs sidecar recovery (division of labor):** per-shard WAL replay **only
  repairs file-tail bytes** for existing streams — it does **not** allocate `stream_id`s
  or own stream identity. Stream identity (`stream_id`/`next_id`) and fork linkage are
  reconstructed by the existing **single, non-sharded sidecar pass** (`recover_one_inner`,
  parent-first), which seeds `next_id` once from `max(sidecar id)+1`. An implementer must
  not wire id-allocation into a shard; replay re-applies records carrying existing ids.
- Discard any torn page-cache tail past `durable_lsn`; rebuild in-memory stream state.

Cost: **O(uncompacted WAL)** — small when checkpointing keeps up. **No torn record is ever
exposed** (incl. JSON): the file is repaired to whole-record boundaries from the framed
WAL — the structural fix for C1.

## 10. The `DurabilitySink` seam (pluggability)

Generalize the relaxed branch's `maybe_sync_on_ack` into a backend the append path selects
at startup:

- `FileSink` — today's per-stream file path; `strict` = fsync-before-ack, `fast` = no
  fsync. **Unchanged behavior.**
- `WalSink` — §3–§9.
- `ReplicationSink` — **future** (follow-up #8); slots in at the same seam (built on the
  `fast` no-fsync write path + quorum ack) — the "trade WAL for replication" path.

When `wal` is off, the WAL module is inert; the server is byte-for-byte the `strict`/`fast`
server.

## 11. Telemetry (per-shard batch size is the headline signal)

1 Hz gauges via the existing `telemetry` plumbing. **Records-per-`fdatasync` is
first-class, as a distribution, per shard and aggregate** — the live proof committers are
healthy and the dial for the follow-ups:

- **batch size:** `p50 / p99 / max` records-per-commit (histogram) + `avg`
  (`records_committed / fsync_count`) + `last_batch`, **per shard** + aggregate.
- per shard: `fsync_rate`, `tail_lsn`, `durable_lsn`, `checkpoint_lsn`, WAL `size_bytes` /
  `segments`; global: `append_block_ns`, `bytes_written`.

Small batch under load ⇒ committers starved or skewed (raise N / rebalance); large batch
that's fsync-amortized but throughput-capped ⇒ per-op syscall overhead ⇒ io_uring
(follow-up #1/#2); a shard's `size_bytes` growing with flat `checkpoint_lsn` ⇒ checkpoint
not keeping up.

## 12. Config + Scope

- **Config:** `--durability strict|wal|fast` (default `strict`); `--wal-shards N` (default
  = core count; persisted at init). `--splice-appends` is honored under `strict`/`fast`,
  **no-op under `wal`** (v1).
- **In:** `--durability wal` (+ rename `relaxed`→`fast`); sharded `fallocate`d segmented
  WAL + B-light framing; hot-path per-stream-file write **+** buffered per-shard WAL write
  via `SegmentWriter`; **per-CPU committers** (group commit, no-loss ack, contiguous
  watermark); **reads unchanged**; per-shard checkpoint (batched per-stream fsync) + WAL
  recycle + disk safety valve; per-shard parallel recovery (incl. `file_base` mapping +
  frontier invariant); per-shard batch telemetry; `DurabilitySink` seam.
- **Out (deferred → `durability-performance-followups.md`):** io_uring `SegmentWriter` (#1)
  and **io_uring for `strict`** (#2); zero-copy WAL double-write (#3); CPU pinning (#4);
  dynamic rebalancing (#5); fast-WAL variant (#6); payload CRC (#7); replication (#8);
  cadence tuning (#9).

## 13. Testing

- **Framing:** header-CRC round-trip; torn-tail detection truncates at the last complete
  record — **truncated header, torn mid-header with partial non-zero bytes, valid-header-
  but-short-payload, `fallocate` trailing zeros**.
- **No-loss:** append K records in `wal` mode (≥2 shards), fsync, simulate crash → all
  acked records recover byte-identical; un-acked tail absent.
- **No torn record (incl. JSON):** leave a torn page-cache tail in a per-stream file + a
  framed WAL covering it; recover → file repaired to the last whole record; reads return
  only whole, valid records.
- **Committer ordering:** out-of-order off-lock completion still acks only after the
  in-shard contiguous prefix is durable.
- **Sharding:** records for streams hashing to different shards land in the right shard's
  WAL; per-shard parallel recovery reconstructs all streams; `file_base`-mapped replay
  places payloads correctly; a WAL record below `file_base` is skipped.
- **N-stability:** boot the same data dir with a different `available_parallelism` → every
  stream still resolves to its persisted shard (shard from persisted `N` + `stream_id`,
  not core count); `--wal-shards` ≠ persisted `N` is rejected (exit 2).
- **Checkpoint non-blocking:** stall a shard's checkpoint → its appends keep acking, reads
  keep working, its WAL `size_bytes` grows, `append_block_ns` ≈ 0.
- **`strict`/`fast` unchanged:** full existing suite green with the WAL module inert.
- **Bench (ds-rust-bench):** `--durability strict|wal|fast` on the cardinality sweep +
  append **+ a single-stream, no-backlog micro-cell** (the cell that isolated v1's per-op
  tax). Report the **per-shard batch distribution**.

## 14. Success criteria

1. **Single-node no-loss:** every acked record in `wal` mode survives a simulated OS
   crash; recovery restores exactly the committed prefix.
2. **No torn record ever recovered or served** in `wal` mode (incl. JSON) — C1 fixed.
3. **Zero-copy reads unchanged**; the WAL is never on the serving path; no in-memory tail;
   `append_block_ns` ≈ 0 **while checkpoint keeps up**.
4. **Performant, honestly scoped:** `wal` is the **no-loss + clean-recovery + better-tails**
   mode. Falsifiable bars: (a) `wal` p99 ≤ `strict` p99 on every sweep cell; (b) `wal`
   throughput ≥ `strict` at N≤1000 streams and **within 10% of `strict` at 10k** (the
   parallel fat-batch fsyncs should let it match or beat `strict` there); (c) no v1-style
   collapse — single-stream no-backlog `wal` throughput ≥ 0.7× `strict` (bounds the per-op
   tax); (d) per-shard batch `p50` grows with offered load. Recovery O(uncompacted WAL).
5. `strict` (default) and `fast` are byte-for-byte the existing per-stream-file paths.
6. io_uring is a drop-in `SegmentWriter` (no architectural change) when first numbers
   justify it.

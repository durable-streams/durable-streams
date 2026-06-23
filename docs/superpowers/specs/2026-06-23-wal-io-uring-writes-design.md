# io_uring write+fsync committer for `--durability wal` — Design Spec

**Repo:** `durable-streams` · **Branch:** `worktree-wal-iouring-writes` (off `vbalegas/wal-v2` @ `f497f199`)
**Crate:** `packages/server-rust` · **Date:** 2026-06-23
**Builds on:** [`2026-06-22-durable-wal-v2-design.md`](./2026-06-22-durable-wal-v2-design.md) · as-built: [`docs/durable-wal.md`](../../durable-wal.md)
**Follow-ups:** `docs/superpowers/durability-performance-followups.md`

**Goal:** Cut **CPU per append** on the `--durability wal` path by replacing the
per-record `pwrite` syscall + `spawn_blocking` `fdatasync` with a per-shard
io_uring ring that batches **N writes + 1 fsync** into ~2 `io_uring_enter`
calls. Linux-only, behind a Cargo feature **and** a CLI flag, **off by default**,
with a runtime probe + graceful fallback. The on-disk WAL format, recovery,
checkpoint, and the durability/no-loss invariants are **unchanged** — only *how*
bytes and fsyncs are issued changes.

## 1. Why (and the honest scope of the win)

- The WAL append path is **fsync-bound and group-committed**: many concurrent
  records amortize into one `fdatasync`. io_uring does **not** make the physical
  device flush faster, so the per-batch *latency floor* barely moves. This is a
  **CPU lever, not a throughput lever** — the same shape as the dropped io_uring
  HTTP engine and `--splice-appends` (both CPU wins, not throughput wins).
- Where the CPU actually goes today (per shard):
  - **Phase 2 of `reserve_and_stage`**: one `libc::pwrite` **per record**, run on
    a tokio worker. This is the dominant per-append syscall — it is **not**
    amortized by group commit (only the fsync is).
  - **Committer**: one `fdatasync` per batch via `tokio::task::spawn_blocking`
    (a task spawn + blocking-pool thread wakeup), amortized across the batch.
- io_uring lets the **sole submitter thread** batch all of a batch's writes plus
  the fsync into ~2 `io_uring_enter` calls. Net at load: `N pwrite + spawn_blocking
  handoff + fdatasync` → `~2 enter`/batch. The win **scales with batch size (i.e.
  concurrency)**; at batch-size-1 it is roughly a wash (handoff + eventfd wake vs
  one `pwrite`). Ship/no-ship is decided on measured A/B (§7).
- The `SegmentWriter` trait already exists in `segment.rs` as the documented
  "io_uring drop-in seam," **but it is too narrow**: its synchronous, per-call
  `write_at` would force one `io_uring_enter` per write (no batching → strictly
  worse than `pwrite`). Hitting the CPU goal requires a new *committer path*, not
  a trait swap. The trait stays for the synchronous/fallback path.

## 2. What does NOT change (risk-limiters)

- **On-disk format:** record framing (`codec.rs`, B-light + CRC32C), segment
  layout (`<start_lsn>.wal`, `fallocate`'d to `SEGMENT_BYTES`), exact-packed
  seals.
- **Recovery:** `replay_from_checkpoint`, `reset_after_recovery`, `recovery.rs`,
  per-stream durable-tails, checkpoint + recycle. A crashed io_uring-written WAL
  is **byte-identical** to a `pwrite`-written one and recovers via the existing
  code. This is the single biggest reason the change is bounded.
- **Durability invariant:** the contiguous-written watermark
  (`written_high` / `written_ahead` / `mark_written`), the
  **snapshot-before-fsync** rule, and `sealed_pending` fsync are reused verbatim.
- **Append ack gating:** acks gate on `durable_tx` via `wait_durable`; the
  checkpoint ticker, telemetry emitter, and shard routing are untouched.
- **Default build:** `default = []`; with the feature off the binary is
  byte-for-byte unchanged (matches `telemetry`/`tier` convention).

## 3. Architecture

```
                    ┌─────────────────────── per shard ───────────────────────┐
 append (tokio)     │  reserve (lock)        staging queue        ring thread  │
 ─────────────►  reserve_and_stage ──► [(lsn, off, buf, fd)] ──► io_uring ring │
                    │   (phase 1)          + eventfd wake          (sole       │
                    │                                              submitter)  │
                    │                                                  │       │
 wait_durable ◄──────────────── durable_tx (watch) ◄── publish ◄──────┘       │
   (-> Result)      │                              (on fsync CQE)              │
                    └──────────────────────────────────────────────────────────┘
```

- **New module** `src/wal/uring.rs`, gated `#[cfg(all(target_os = "linux",
  feature = "wal-uring"))]`, using the raw [`io-uring`] crate (SQE-level control
  for batched submit + `IORING_OP_WRITE` / `IORING_OP_FSYNC`).
- **One dedicated OS thread per shard**, each owning **one ring**. Mirrors the
  per-shard committer model; fsync concurrency scales with shard count (the
  intent of commit `f497f199`); no cross-shard contention.
- The thread is the **sole submitter** (io_uring SQ is single-producer; making
  appenders submit directly would need a per-ring lock that re-serializes and
  throws away the batching — explicitly rejected, see §8).
- **Bridge to async:** the thread publishes to the **existing** `durable_tx`
  watch; tokio appenders waiting in `wait_durable` wake exactly as today. No
  second runtime is introduced (deliberately *not* `tokio-uring`, which needs a
  current-thread-per-core runtime — that was the basis of the dropped HTTP
  engine; here io_uring lives only on the durability seam).

[`io-uring`]: https://crates.io/crates/io-uring

## 4. Hot-path data flow (per shard)

1. **Reserve** (`reserve_and_stage` phase 1, **unchanged**): take the short lock,
   assign `lsn` + segment offset, bump `next_lsn`/`write_pos`, handle roll/seal
   synchronously (rare; see §5).
2. **Stage → handoff** (phase 2, **changed under the feature**): encode the framed
   record into a `Vec<u8>` (as today), then instead of `write_at`, push
   `StagedWrite { lsn, off, buf, seg_fd, seg: Arc<FileSegment> }` onto the shard's
   MPSC staging queue and wake the ring thread via an **eventfd**. The eventfd
   write is **skipped** when an atomic `armed` flag shows the thread is already
   draining, so under load the wake amortizes to ~0 syscalls/append. The `Arc`
   keeps the target segment alive until the write CQE.
3. **Ring thread** blocks in `submit_and_wait` (a persistent eventfd-read SQE is
   its wakeup). On wake it drains the queue and submits **one write SQE per
   record** (`user_data` encodes the lsn + op-kind), batched into **one
   `io_uring_enter`**.
4. **Write CQE** → `mark_written(lsn)` advances the existing contiguous watermark
   (`BTreeSet` already tolerates out-of-order CQEs). The owned `buf` is held in an
   in-flight map until its CQE, then dropped (buffer-lifetime safety: the kernel
   may touch `buf` until completion).
5. **fsync**: after reaping a batch of write CQEs, **snapshot** `written_high`,
   then submit one `IORING_OP_FSYNC` (`fdatasync` semantics via
   `FsyncFlags::DATASYNC`) for the active segment plus one per `sealed_pending`
   segment.
6. **fsync CQE** → publish `durable_lsn = snapshot` to `durable_tx`, record the
   batch-size stat, drop the now-durable in-flight buffers, and retire
   `sealed_pending` entries `≤ snapshot`. **Snapshot-before-fsync preserved
   verbatim:** records whose write CQE arrived *during* the fsync are excluded and
   caught by the next batch (re-snapshotting would over-advance `durable_lsn` past
   pages this fsync may not have flushed — a data-loss bug).

No `IOSQE_IO_LINK`/`IO_DRAIN` chaining: a hard link would serialize the writes and
a drain would barrier the whole pipeline. Batched-writes-then-snapshot-then-fsync
gives parallel writes + correct durability without either.

## 5. Correctness

### 5.1 Watermark (unchanged semantics)
The only redefinition: "written" changes from "`pwrite` returned" to "write CQE
reaped." Both mean *the bytes are in the page cache for that segment* — exactly the
precondition the snapshot-before-fsync rule requires. Out-of-order write CQEs are
handled by the existing `written_ahead` `BTreeSet`. A reserved-but-never-completed
lsn (gap) blocks the watermark permanently, identical to today.

### 5.2 Failure semantics (the one behavior change — signed off)
Today: a phase-2 `write_at` error returns `Err` inline → **immediate 5xx**; an
`fdatasync` error → don't advance, **retry on next notify** (those acks block until
a later fsync succeeds).

With async completion the write error arrives as a CQE on the ring thread, not
inline. To preserve "a write error fails that ack":

- **Write-CQE error:** the ring thread records the lsn into a `failed` set and bumps
  a fault generation that `wait_durable` also observes. The waiting appender returns
  `Err(WalError)` → **5xx** — same observable behavior as today's `write_at`
  failure. The lsn is never `mark_written`, so `durable_lsn` correctly never
  advances past it (permanent gap, as in the sync path).
- **fsync-CQE error:** mirror today exactly — do **not** advance, do **not** publish;
  retry on the next batch. Acks for those lsns block until a later fsync succeeds.
- **Ring-thread panic / unrecoverable ring error:** mark the shard **failed**; its
  pending and future `wait_durable` calls return `Err` (→ 5xx) rather than hang.

**Signature change:** `Shard::wait_durable(&self, lsn) -> ()` becomes
`-> Result<(), WalError>`. The synchronous committer path always resolves advanced
lsns to `Ok`, so its callers' behavior is unchanged; `maybe_sync_on_ack` maps `Err`
to the same 5xx it already returns for a sync `write_at` failure.

### 5.3 Roll / seal (unchanged, synchronous)
`seal_to` (set_len + full fsync) and opening the fresh segment stay under the
reserve lock on the appender side (rare, off the per-record path). Each staged
record carries its **target** segment (`Arc` + fd), so the ring thread needs no
"active segment changed" coordination — it writes each record to the fd it was
handed. `sealed_pending` segments are fsync'd by the ring thread (extra fsync SQEs
in the batch), closing the same no-window invariant documented in `shard.rs`.

### 5.4 Recovery (untouched)
io_uring changes only issuance, not bytes. A crash leaves a WAL that the existing
`recovery.rs` reconstructs to exactly the acked (published-`durable_lsn`) prefix.
The crash/recovery test (§7) asserts this equivalence directly.

## 6. Gating, fallback, platform

- **Cargo:** `io-uring` as an `optional` dep; `wal-uring = ["dep:io-uring"]`;
  `default = []`. Feature-off build is byte-for-byte unchanged.
- **CLI flag:** `--wal-io-uring` (only meaningful with `--durability wal`). On
  non-Linux or feature-off builds it is **accepted-but-ignored with a warning**, so
  the same command line works everywhere (falls back to the sync committer).
- **Runtime probe:** at `WalSet::spawn_committers`, attempt to build one ring; on
  failure (old kernel, or seccomp/container without io_uring — the same constraint
  the old uring HTTP engine hit, needing `--privileged`) log a clear warning and
  fall back to the tokio-task committer for **all** shards. No hard dependency on a
  privileged environment.
- **Kernel floor:** io_uring + `IORING_OP_FSYNC` are old (≥5.1); documented as the
  minimum, with the probe covering anything older via fallback.
- **release profile:** stays `unwind` (no change). The ring thread is a plain OS
  thread; its panic marks the shard failed (§5.2), never silently wedges it.
- **`spawn_committers` branch:** feature+flag+probe all true → spawn one dedicated
  ring thread per shard; otherwise → the existing `tokio::spawn(run_committer())`.

## 7. Testing & benchmarking

- **Unit tests** (`uring.rs`, Linux + feature gated), mirroring the `shard.rs`
  suite against the ring committer:
  - write+fsync batch makes records durable (`wait_durable` resolves, bytes on
    disk, replay reconstructs them);
  - out-of-order write CQEs collapse the watermark correctly;
  - a forced **write-CQE error** fails that lsn's `wait_durable` (→ `Err`) and
    leaves a permanent watermark gap;
  - roll across ≥3 segments stays fully durable;
  - eventfd wake-skip path (armed flag) does not lose a staged record
    (lost-wakeup safety analogous to the `Notify` argument).
- **Conformance:** full suite with `--durability wal --wal-io-uring` on Linux
  (Docker, io_uring allowed) — must be **332/332**, identical to the sync WAL
  path. macOS host falls back → also green.
- **Crash/recovery:** kill mid-append with io_uring writes in flight; unchanged
  recovery must reconstruct exactly the acked prefix (proves on-disk equivalence).
- **Benchmark (the deciding artifact):** A/B `--durability wal` vs
  `--durability wal --wal-io-uring` on Linux, measuring **server CPU at fixed
  append throughput** across concurrency (c1 → high), p99 secondary. Hypothesis:
  CPU/append drops as batch size grows, ~wash at c1. Reuse the existing
  `~/workspace/durable-streams-bench` harness. Decision is data-driven.

## 8. Decisions & rejected alternatives

- **Raw `io-uring`, not `tokio-uring`:** io_uring confined to the durability seam;
  no second runtime; SQE-level control needed for batched submit. (`tokio-uring`
  was the dropped HTTP engine's basis.)
- **Write+fsync through the ring, not fsync-only:** fsync-only barely moves
  CPU/append (the per-record `pwrite` stays); it does not target the goal.
- **One ring per shard, not one shared ring:** a shared ring serializes
  submissions across shards and re-introduces the contention sharding removed.
- **Dedicated submitter thread, not appenders-submit-under-lock:** direct
  submission needs a per-ring lock (SQ is single-producer) that re-serializes and
  discards batching.
- **No `IO_LINK`/`IO_DRAIN`:** would serialize writes / barrier the pipeline;
  batched-writes-then-snapshot-then-fsync is correct without them.
- **v1 scope = non-aggressive (signed off):** no registered fixed buffers, no
  SQPOLL. If the benchmark shows CPU is still submission-bound, those are a
  documented follow-up (`durability-performance-followups.md`), not v1.

## 9. Out of scope / follow-ups

- Registered fixed buffers + `IORING_REGISTER_FILES` for the segment fds.
- `SQPOLL` (kernel-side submission polling → zero `io_uring_enter` on submit).
- io_uring for the **strict**-mode per-stream `SyncCoalescer` fsync path.
- io_uring for the checkpoint per-stream-file fsyncs.

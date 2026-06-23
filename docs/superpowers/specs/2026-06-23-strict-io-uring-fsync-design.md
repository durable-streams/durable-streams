# io_uring fsync executor for `--durability strict` — Design Spec

**Repo:** `durable-streams` · **Branch:** `worktree-wal-iouring-writes` (continues the io_uring line)
**Crate:** `packages/server-rust` · **Date:** 2026-06-23
**Sibling work:** [`2026-06-23-wal-io-uring-writes-design.md`](./2026-06-23-wal-io-uring-writes-design.md) (io_uring for the WAL committer — shipped on this branch)
**Follow-ups:** `docs/superpowers/durability-performance-followups.md` (this is item #2)

**Goal:** Cut **CPU per append** (and improve the high-stream-cardinality regime) on the
`--durability strict` path by replacing the per-stream `spawn_blocking(barrier_fsync)`
with an io_uring **fsync executor** that batches many streams' `fdatasync`s into ~1
`io_uring_enter` and offloads the blocking work to the kernel's io-wq instead of the
tokio blocking-thread pool. Linux-only, behind a Cargo feature **and** a CLI flag,
**off by default**, runtime probe + graceful fallback. On-disk data, recovery, and the
strict durability guarantee are **unchanged** — only _where/how_ the per-stream
`fdatasync` is issued changes.

## 1. Why (and the honest scope of the win)

- Strict acks are gated on a **per-stream** `fdatasync` (`SyncCoalescer::sync_to`):
  a leader does `tokio::task::spawn_blocking(|| barrier_fsync(file))` while followers
  coalesce onto it (`store.rs:152-228`). With many streams (e.g. 10K) there are many
  _independent_ coalescers → up to thousands of concurrent `spawn_blocking` hops, each a
  `fdatasync` syscall, bounded by the tokio blocking pool.
- **Most real workloads have small payloads**, so strict's cost is dominated by these
  per-append _syscalls_ + the blocking-pool hop — not by data movement. This is exactly
  where io_uring helps: batch the fsync **submissions** into one `io_uring_enter` and let
  the kernel io-wq run the `fdatasync`s, removing the userspace blocking-thread hop.
- Honest framing (same shape as the WAL io_uring result): this is a **CPU-per-append
  lever** and a **high-cardinality scaling** lever (the blocking pool stops being the
  ceiling). It does **not** make the physical device flush faster; per-fsync latency is
  unchanged. Ship/no-ship-by-default is decided on the measured A/B.
- Unlike the WAL committer (few shards → one ring+thread each), strict has **many
  streams** → a ring-per-stream is impossible. The right unit is a **single shared
  fsync executor** that all streams submit to.

## 2. What does NOT change (risk-limiters)

- **On-disk data:** strict writes the wire bytes to the per-stream file exactly as today
  (`write_wire`); only the subsequent `fdatasync` issuance changes.
- **Recovery:** strict mode does not touch the WAL/recovery path at all. No change.
- **`SyncCoalescer` semantics:** leader/follower election, the coverage watermark
  (`covers = shared.tail − file_base`), the `watch` broadcast, and `LeaderGuard`
  cancellation safety are reused verbatim. Only the single line that performs the leader's
  fsync is swapped.
- **Durability guarantee:** Linux strict already uses `fdatasync` (`barrier_fsync`,
  `store.rs:262-284`); io_uring `IORING_OP_FSYNC` with `FsyncFlags::DATASYNC` is the same
  `fdatasync` semantics → identical durability. **macOS keeps `F_FULLFSYNC`** via the
  unchanged fallback (io_uring path is Linux-only).
- **Default build:** `default = []`; feature off ⇒ byte-for-byte the current server,
  warning-clean. Matches the `wal-uring`/`tier`/`telemetry` convention.

## 3. Architecture

```
 strict append (tokio task)                         UringFsync (1 ring, 1 thread)
 ──────────────────────────                         ─────────────────────────────
 maybe_sync_on_ack(Strict)
   └─ SyncCoalescer::sync_to  (leader)
        pool.fsync(Arc<File>).await ─┐
                                     │ enqueue (id, fd) + register oneshot+Arc<File>
                                     ├──────────────► [slab: id → (oneshot, Arc<File>)]
                                     │                 eventfd wake
        await oneshot  ◄─────────────┘                      │
            │                                               ▼
            │                            thread: submit N FSYNC/DATASYNC SQEs (1 enter),
            │                                    kernel io-wq runs fdatasyncs concurrently,
            └──── result ◄──── oneshot.send(res) ◄── reap CQEs → lookup id → send + drop Arc
```

- **New module** `src/uring_fsync.rs`, gated `#[cfg(all(target_os = "linux", feature =
"strict-uring"))]`, raw `io-uring` crate (the optional dep already added for `wal-uring`).
- **`UringFsync`** owns: the ring, the dedicated thread, an MPSC submission queue
  (`Mutex<VecDeque<(u64 id, RawFd)>>`), an eventfd + `armed` flag (reused lost-wakeup
  protocol), and an in-flight **slab** `Mutex<HashMap<u64, (oneshot::Sender<io::Result<()>>,
Arc<File>)>>`. A monotonic `AtomicU64` issues `user_data` ids (never the reserved
  eventfd-wake sentinel).
- **`pub fn start() -> io::Result<UringFsync>`** — create ring + eventfd, spawn the thread,
  return the handle. **`pub fn probe() -> bool`** — `IoUring::new(8).is_ok()`.
- **`pub async fn fsync(&self, file: Arc<File>) -> io::Result<()>`** — allocate id, insert
  `(oneshot_tx, Arc::clone(&file))` into the slab, push `(id, file.as_raw_fd())` to the
  queue, wake the thread (eventfd, skipped when armed), `oneshot_rx.await`.
- **Async bridge** (the one new thing vs the WAL committer, which used a watch channel):
  the caller awaits _its_ fsync via a per-call `oneshot`. The thread reaps a CQE, looks up
  its `user_data` id in the slab, sends the result on the oneshot, and drops the `Arc<File>`
  (fd kept alive exactly until its CQE).

## 4. Integration (minimal)

- **Process-global handle:** `static STRICT_URING: OnceLock<Arc<UringFsync>>` (mirrors the
  existing global `DURABILITY_MODE` atomic and `Store.wal` OnceLock). Set once at startup.
- **`SyncCoalescer::sync_to` leader branch** (`store.rs`): replace
  ```rust
  let res = tokio::task::spawn_blocking(move || barrier_fsync(&f)).await
              .unwrap_or_else(|e| Err(io::Error::other(...)));
  ```
  with
  ```rust
  let res = match strict_uring_handle() {            // reads STRICT_URING (None on non-Linux/feature-off/fallback)
      Some(pool) => pool.fsync(Arc::clone(&f)).await,
      None => tokio::task::spawn_blocking(move || barrier_fsync(&f)).await
                  .unwrap_or_else(|e| Err(io::Error::other(format!("fsync task panicked: {e}")))),
  };
  ```
  Nothing else in `sync_to` changes. `strict_uring_handle()` is a thin accessor that returns
  `None` when the module is compiled out (non-Linux/feature-off) so `store.rs` stays
  portable.

## 5. Gating, fallback, platform

- **Cargo:** `strict-uring = ["dep:io-uring"]` (reuses the existing optional `io-uring` dep);
  `default = []`.
- **CLI flag:** `--strict-io-uring` (only meaningful with `--durability strict`). On
  non-Linux/feature-off builds: accepted-but-ignored with a warning (same command line works
  everywhere; falls back to `spawn_blocking`).
- **Runtime probe:** at startup, if the flag is set and (Linux+feature) and `probe()`
  succeeds → `UringFsync::start()` and set `STRICT_URING`, log `strict: io_uring fsync active`.
  On any failure (old kernel, seccomp-restricted sandbox) → log a warning, leave the global
  unset → the `spawn_blocking` path. No hard dependency on a privileged environment (note:
  like all io_uring here, containers need an unrestricted seccomp profile — the bench
  manifest already sets `seccompProfile: Unconfined`).
- **release profile:** unchanged (`unwind`). The ring thread is a plain OS thread; on panic
  it drains in-flight oneshots with `Err` so no `sync_to` hangs.

## 6. Failure semantics

- **fsync-CQE error:** the oneshot resolves `Err(io::Error)` → `sync_to` leader returns
  `Err` → ack 5xx. Identical observable behavior to today's `barrier_fsync` error.
- **Ring-thread fatal error / panic:** drain every in-flight slab entry's oneshot with an
  `Err` (so waiting leaders fail their acks rather than hang); the thread exits. A subsequent
  strict ack with no live executor still works only if the global was unset — so a fatal
  executor is a process-level failure surfaced via failed acks (operator restarts).
  (v1: do not auto-respawn; document as a follow-up if it matters.)
- **Leader cancellation:** if the leader future is dropped mid-fsync (the existing
  `LeaderGuard` releases leadership), the `oneshot::Receiver` drops; the ring thread still
  reaps the CQE, finds the sender closed (send is a no-op), and drops the `Arc<File>`. No
  leak, no UB.

## 7. Testing & benchmarking

- **Unit tests** (`uring_fsync.rs`, Linux+feature gated; Docker `--privileged`):
  - write bytes to a temp file, `pool.fsync(file).await` → `Ok`, bytes present on disk;
  - a deliberately bad fd (e.g. via a `#[cfg(test)]` injection) → the awaiter gets `Err`;
  - many concurrent `fsync` calls over distinct files all resolve `Ok` (batching /
    slab correctness, no cross-wiring of results);
  - lost-wakeup: a submission racing the thread's sleep is still serviced (armed-flag).
- **Conformance:** full suite with `--durability strict --strict-io-uring` on Linux
  (Docker) — must match the strict baseline (326/332; the 6 skips are the disabled
  subscription suite), identical to plain `--durability strict`.
- **Benchmark (the deciding artifact):** A/B `--durability strict` vs
  `--durability strict --strict-io-uring` at **10K streams**, write workload, measuring
  **server CPU% at matched throughput** (primary) + throughput + p99 (secondary), on
  server-bound cells. Reuse the `ds-rust-bench` harness (add a `durable:strict-iouring`
  variant, analogous to the `durable:wal-iouring` variant). Hypothesis: CPU/append drops vs
  plain strict, with the gap widening as stream cardinality rises (blocking pool relieved).

## 8. Decisions & rejected alternatives

- **Single shared ring+thread, not a pool:** the submitter thread only enqueues/reaps
  (cheap); the kernel io-wq parallelizes the `fdatasync`s. Simplest; grows to a pool later if
  the single submitter is shown to bottleneck.
- **Not a ring-per-stream:** 10K streams ⇒ 10K threads/rings — infeasible. The executor is
  shared across all streams.
- **`oneshot` async bridge, not a watch channel:** unlike the WAL committer (where waiters
  gate on a monotonic watermark), each strict leader awaits _its own_ fsync result.
- **Reuse the `io-uring` dep + eventfd/armed/probe patterns from `wal/uring.rs`**, but a
  separate module + feature: strict's executor is structurally different (async per-call
  bridge, no segments/watermark) and is independently selectable from the WAL committer.
- **Linux-only:** macOS strict requires `F_FULLFSYNC` (true platter flush), which io_uring
  does not provide; macOS keeps the existing `barrier_fsync` path. No durability regression.

## 9. Out of scope / follow-ups

- Pool of rings (size flag) if the single submitter thread bottlenecks.
- Auto-respawn of a crashed executor thread.
- io_uring for the WAL **checkpoint** per-stream-file fsyncs (a third site that calls
  `barrier_fsync`).
- Registered fixed files / `SQPOLL` (carried over from the WAL spec §9).

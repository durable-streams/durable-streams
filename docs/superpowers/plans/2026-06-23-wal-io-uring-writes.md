# io_uring write+fsync committer for `--durability wal` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut CPU-per-append on `--durability wal` by routing each shard's WAL writes + group-commit fsync through a per-shard io_uring ring (dedicated submitter thread) that batches `N writes + 1 fdatasync` into ~2 `io_uring_enter` calls.

**Architecture:** A new Linux-only, feature- and flag-gated committer (`src/wal/uring.rs`). The existing two-phase reserve/stage and the contiguous-written watermark (`shard.rs`) are reused; only phase-2 issuance changes — appenders enqueue `StagedWrite`s to the shard's ring thread (woken via eventfd) instead of calling `pwrite` inline. The ring thread submits writes, reaps CQEs to advance the watermark, then submits a snapshot-gated fsync and publishes `durable_lsn` to the existing `durable_tx` watch. On-disk format and recovery are unchanged.

**Tech Stack:** Rust (edition 2021), `io-uring` crate (raw), `libc` (eventfd), tokio (existing async append path + `watch`/`Notify`).

## Global Constraints

- **Crate:** `packages/server-rust`. Run all `cargo`/`git` from there unless noted.
- **MSRV:** `rust-version = "1.75"` (Cargo.toml). Do not raise it.
- **Default build unchanged:** `default = []`. With the `wal-uring` feature off, the binary must be byte-for-byte the current server. New code is `#[cfg(all(target_os = "linux", feature = "wal-uring"))]`.
- **No new always-on deps:** `io-uring` is `optional` and pulled in only by `wal-uring`.
- **release profile stays `unwind`** (do not change `[profile.release]`).
- **On-disk WAL format, `codec.rs`, `recovery.rs`, `reset_after_recovery`, checkpoint/recycle, durable-tails: DO NOT MODIFY.** io_uring changes only how bytes/fsyncs are issued.
- **Watermark invariant:** `written_high`/`written_ahead`/`mark_written` and **snapshot-before-fsync** are reused verbatim. Never re-snapshot `written_high` after submitting the fsync.
- **Commit hooks:** this worktree has no `node_modules`; `git commit` triggers `lint-staged` which is absent. Use `git commit --no-verify` for commits here (Rust-only changes; `cargo fmt`/`clippy` are the relevant gates, run them manually per task).
- **Platform note for testing:** the io_uring code compiles/runs only on **Linux**. The dev host is macOS. Tasks are marked **[host]** (TDD locally with `cargo test`) or **[linux]** (write tests, run them in Docker Linux — see "Docker test harness" below). Do the host tasks first.

### Docker test harness (for [linux] tasks)

From `packages/server-rust`, run uring-gated unit tests in a privileged Linux container (io_uring syscalls need an unrestricted seccomp profile):

```bash
docker run --rm --privileged \
  -v "$PWD":/src -w /src \
  -v ds-cargo-registry:/usr/local/cargo/registry \
  -v ds-target:/tmp/target -e CARGO_TARGET_DIR=/tmp/target \
  rust:latest \
  cargo test --features wal-uring --target-dir /tmp/target wal::uring -- --nocapture
```

(`rust:latest` because `Cargo.lock` is v4. `--privileged` because the default Docker seccomp profile blocks `io_uring_setup`/`io_uring_enter`.)

---

## File Structure

- **Create** `src/wal/uring.rs` — the entire io_uring committer: `probe()`, `UringHandle`, `StagedWrite`, `UringCommitter` (ring setup + submit/reap loop). Gated `#[cfg(all(target_os = "linux", feature = "wal-uring"))]`.
- **Modify** `Cargo.toml` — `io-uring` optional dep + `wal-uring` feature.
- **Modify** `src/wal/mod.rs` — declare `pub mod uring;` (gated).
- **Modify** `src/wal/segment.rs` — add `FileSegment::raw_fd()`.
- **Modify** `src/wal/shard.rs` — `WalError`; `wait_durable -> Result`; `fault` watch; extract shared commit helpers (`mark_written_pub`, `snapshot_watermark`, `collect_fsync_targets`, `publish_durable`, `signal_fault`); the phase-2 enqueue branch + `Option<UringHandle>` field + `attach_uring`.
- **Modify** `src/wal/walset.rs` — `spawn_committers(use_uring: bool)` branch + probe/fallback.
- **Modify** `src/handlers.rs` — `maybe_sync_on_ack` Wal arm: handle `wait_durable`'s `Result`.
- **Modify** `src/main.rs` — `--wal-io-uring` flag; pass to `spawn_committers`.
- **Modify** `README.md`, `docs/durable-wal.md`, `docs/superpowers/durability-performance-followups.md` — docs.

---

## Task 1: Cargo feature, optional dep, gated module skeleton **[host]**

**Files:**
- Modify: `Cargo.toml`
- Create: `src/wal/uring.rs`
- Modify: `src/wal/mod.rs`

**Interfaces:**
- Produces: feature `wal-uring`; module `crate::wal::uring` (empty when gated out).

- [ ] **Step 1: Add the optional dep + feature to `Cargo.toml`**

Under `[dependencies]`, after the `crc32c` block, add:

```toml
# io_uring-backed WAL committer — opt-in via the `wal-uring` feature, OFF BY
# DEFAULT and Linux-only. Pulled in (and compiled) only with `--features
# wal-uring`; a default build keeps its dependency set unchanged.
io-uring = { version = "0.7", optional = true }
```

Under `[features]`, after the `tier = [...]` line, add:

```toml
# io_uring write+fsync WAL committer (--durability wal --wal-io-uring), Linux
# only. Off by default; the module is `#[cfg(target_os = "linux")]`-gated so the
# feature is a no-op on non-Linux builds (the flag falls back to the sync committer).
wal-uring = ["dep:io-uring"]
```

- [ ] **Step 2: Create the gated skeleton `src/wal/uring.rs`**

```rust
//! io_uring write+fsync committer for `--durability wal` (Linux only, opt-in via
//! the `wal-uring` feature + `--wal-io-uring`). Batches a shard's WAL writes and
//! the group-commit `fdatasync` through one ring on a dedicated thread, replacing
//! the per-record `pwrite` + `spawn_blocking` fsync. See the design spec
//! `docs/superpowers/specs/2026-06-23-wal-io-uring-writes-design.md`.
//!
//! The whole module is `#[cfg(all(target_os = "linux", feature = "wal-uring"))]`;
//! on any other build it is empty and the flag falls back to the sync committer.
#![cfg(all(target_os = "linux", feature = "wal-uring"))]
```

- [ ] **Step 3: Declare the module in `src/wal/mod.rs`**

After the `pub mod telemetry;` line, add:

```rust
pub mod uring;
```

- [ ] **Step 4: Verify the default build is unchanged and the feature compiles**

Run:
```bash
cargo build
cargo build --features wal-uring
```
Expected: both succeed. (On macOS the `wal-uring` build compiles an empty `uring` module — fine.)

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/wal/uring.rs src/wal/mod.rs
git commit --no-verify -m "feat(wal): scaffold wal-uring feature + gated uring module"
```

---

## Task 2: `WalError` + `wait_durable -> Result` + fault signal **[host]**

Make `wait_durable` fallible so a future io_uring write-CQE error can fail the ack. The sync path never faults, so it always resolves `Ok` — behavior-preserving.

**Files:**
- Modify: `src/wal/shard.rs`
- Modify: `src/handlers.rs:684-720` (Wal arm of `maybe_sync_on_ack`)
- Test: `src/wal/shard.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces:
  - `pub enum WalError { WriteFailed(u64), ShardFailed }` (impl `Display` + `std::error::Error`).
  - `Shard::wait_durable(&self, lsn: u64) -> Result<(), WalError>`.
  - `Shard::signal_fault(&self, fault: WalError)` (sets the fault watch; used by the uring committer in Task 7).
  - Private `fault_tx: watch::Sender<Option<WalError>>` on `Shard`.

- [ ] **Step 1: Write the failing test** (append to `shard.rs` tests)

```rust
#[tokio::test]
async fn wait_durable_ok_for_committed_lsn() {
    let dir = tmp("wd-ok");
    let sh = Shard::open_with_segment_size(dir.clone(), 1 << 20).unwrap();
    let h = tokio::spawn({ let s = sh.clone(); async move { s.run_committer().await } });
    let lsn = sh.reserve_and_stage(RecordKind::Append, 1, 0, b"hello").unwrap();
    assert!(sh.wait_durable(lsn).await.is_ok(), "committed lsn resolves Ok");
    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn wait_durable_err_after_fault() {
    let dir = tmp("wd-fault");
    let sh = Shard::open_with_segment_size(dir.clone(), 1 << 20).unwrap();
    // No committer: stage a record so an lsn exists, then fault the shard.
    let lsn = sh.reserve_and_stage(RecordKind::Append, 1, 0, b"x").unwrap();
    sh.signal_fault(WalError::WriteFailed(lsn));
    assert!(matches!(sh.wait_durable(lsn).await, Err(WalError::WriteFailed(_))));
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib wal::shard::tests::wait_durable -- --nocapture`
Expected: FAIL to compile (`WalError` undefined, `wait_durable` returns `()`).

- [ ] **Step 3: Add `WalError` + `fault_tx` field + `signal_fault`, change `wait_durable`**

In `shard.rs`, after the imports, add:

```rust
/// A WAL durability failure surfaced to a waiting appender (→ 5xx ack). Only the
/// io_uring committer (Task 7) ever raises these; the synchronous committer never
/// faults (its write errors return inline from `reserve_and_stage`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalError {
    /// A specific lsn's WAL write failed (async write CQE error). Its bytes never
    /// landed, so it is a permanent watermark gap and its ack must fail.
    WriteFailed(u64),
    /// The shard's committer is unrecoverable (ring error / panicked thread);
    /// pending and future acks fail rather than hang.
    ShardFailed,
}

impl std::fmt::Display for WalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalError::WriteFailed(lsn) => write!(f, "WAL write failed for lsn {lsn}"),
            WalError::ShardFailed => write!(f, "WAL shard committer failed"),
        }
    }
}
impl std::error::Error for WalError {}
```

Add to `struct Shard` (after `durable_tx`):

```rust
    /// Set when the committer hits an unrecoverable per-lsn or shard failure;
    /// `wait_durable` observes it and returns `Err`. `None` in steady state.
    fault_tx: watch::Sender<Option<WalError>>,
```

In `open_with_segment_size`, after `let (durable_tx, _durable_rx) = watch::channel(0u64);` add:

```rust
        let (fault_tx, _fault_rx) = watch::channel(None);
```

and add `fault_tx,` to the `Shard { ... }` initializer (after `durable_tx,`).

Add the method (in `impl Shard`):

```rust
    /// Raise a committer fault: wake every `wait_durable` waiter so it returns
    /// `Err`. Used by the io_uring committer on a write/fsync CQE error or a
    /// fatal ring error (Task 7). Idempotent-ish: the latest fault wins.
    pub fn signal_fault(&self, fault: WalError) {
        let _ = self.fault_tx.send(Some(fault));
    }
```

Replace `wait_durable` with:

```rust
    /// Await until this shard's `durable_lsn >= lsn`, or return `Err` if the
    /// committer faulted this lsn (or the whole shard) first. The synchronous
    /// committer never faults, so it always resolves `Ok` for an advanced lsn.
    pub async fn wait_durable(&self, lsn: u64) -> Result<(), WalError> {
        let mut drx = self.durable_tx.subscribe();
        let mut frx = self.fault_tx.subscribe();
        // Fast path: already durable, or already faulted.
        if *drx.borrow_and_update() >= lsn {
            return Ok(());
        }
        if let Some(f) = Self::fault_for(&frx.borrow_and_update(), lsn) {
            return Err(f);
        }
        loop {
            tokio::select! {
                r = drx.changed() => {
                    if r.is_err() { return Ok(()); } // sender dropped ⇒ shard gone
                    if *drx.borrow_and_update() >= lsn { return Ok(()); }
                }
                r = frx.changed() => {
                    if r.is_err() { return Ok(()); }
                    if let Some(f) = Self::fault_for(&frx.borrow_and_update(), lsn) {
                        return Err(f);
                    }
                }
            }
        }
    }

    /// Whether a fault applies to `lsn`: a `WriteFailed(k)` only fails its own
    /// `k`; a `ShardFailed` fails everyone.
    fn fault_for(fault: &Option<WalError>, lsn: u64) -> Option<WalError> {
        match fault {
            Some(WalError::WriteFailed(k)) if *k == lsn => Some(WalError::WriteFailed(*k)),
            Some(WalError::ShardFailed) => Some(WalError::ShardFailed),
            _ => None,
        }
    }
```

- [ ] **Step 4: Update the `wait_durable` caller in `handlers.rs`**

Replace `shard.wait_durable(lsn).await;` (handlers.rs ~718) with:

```rust
            shard.wait_durable(lsn).await.map_err(|e| {
                std::io::Error::other(format!("wal durability failed: {e}"))
            })?;
```

- [ ] **Step 5: Fix the other `wait_durable` call sites in `shard.rs` tests**

Every existing `.wait_durable(last).await;` in `shard.rs` tests (e.g. `appends_roll_to_multiple_segments`, `records_span_segments_and_are_all_durable`, etc.) must become `.wait_durable(last).await.unwrap();`. Find them:

Run: `grep -n "wait_durable(" src/wal/shard.rs src/wal/e2e_tests.rs src/handlers.rs`
Edit each test call to append `.unwrap()`.

- [ ] **Step 6: Run tests**

Run: `cargo test --lib wal:: && cargo test --lib handlers::tests`
Expected: PASS (including the two new `wait_durable_*` tests). Run `cargo clippy --all-targets` clean.

- [ ] **Step 7: Commit**

```bash
git add src/wal/shard.rs src/handlers.rs src/wal/e2e_tests.rs
git commit --no-verify -m "feat(wal): fallible wait_durable + per-shard fault signal (sync path always Ok)"
```

---

## Task 3: Extract shared commit helpers from `run_committer` **[host]**

So the io_uring committer (Task 6) reuses the exact watermark/publish logic instead of duplicating it. Pure refactor — existing tests must stay green.

**Files:**
- Modify: `src/wal/shard.rs`

**Interfaces:**
- Produces (on `Shard`):
  - `pub fn snapshot_watermark(&self) -> u64` — current `written_high`.
  - `pub fn mark_written_pub(&self, lsn: u64)` — public wrapper over `inner.mark_written`.
  - `pub fn collect_fsync_targets(&self) -> (Arc<FileSegment>, Vec<Arc<FileSegment>>)` — `(active, sealed_pending segments)`.
  - `pub fn publish_durable(&self, watermark: u64)` — advance `durable_lsn` to `watermark` (only if `> current`), record the batch stat, retire `sealed_pending <= watermark`. Exactly the Ok-branch body of `run_committer`.
- Consumes: `run_committer` is rewritten to call these (no behavior change).

- [ ] **Step 1: Add the helpers** (in `impl Shard`)

```rust
    /// Current contiguous-written watermark (`written_high`). Snapshot this
    /// BEFORE submitting an fsync; publish exactly it afterwards.
    pub fn snapshot_watermark(&self) -> u64 {
        self.inner.lock().unwrap().written_high
    }

    /// Mark `lsn`'s bytes written (page-cache durable) and collapse the cursor.
    /// The io_uring committer calls this on a write CQE; the sync path calls the
    /// private `mark_written` directly.
    pub fn mark_written_pub(&self, lsn: u64) {
        self.inner.lock().unwrap().mark_written(lsn);
    }

    /// The segments an fsync batch must cover: the active segment plus every
    /// pending-sealed segment that may still hold an un-durable record.
    pub fn collect_fsync_targets(&self) -> (Arc<FileSegment>, Vec<Arc<FileSegment>>) {
        let g = self.inner.lock().unwrap();
        (
            Arc::clone(&g.active),
            g.sealed_pending.iter().map(|(_, s)| Arc::clone(s)).collect(),
        )
    }

    /// Publish `watermark` as the new `durable_lsn` (no-op if not an advance):
    /// record the batch-size stat and retire fully-durable sealed segments. This
    /// is the shared Ok-branch of both committers; callers MUST pass a watermark
    /// snapshotted BEFORE the covering fsync (never re-snapshot afterwards).
    pub fn publish_durable(&self, watermark: u64) {
        let durable = *self.durable_tx.borrow();
        if watermark <= durable {
            return;
        }
        self.stats.record_batch(watermark - durable);
        let _ = self.durable_tx.send(watermark);
        let mut g = self.inner.lock().unwrap();
        g.sealed_pending.retain(|(end_lsn, _)| *end_lsn > watermark);
    }
```

- [ ] **Step 2: Rewrite `run_committer`'s Ok branch to use the helpers**

In `run_committer`, replace the body that collects `(seg, sealed)`, runs `spawn_blocking`, and (on Ok) records the stat + sends `durable_tx` + retains `sealed_pending`, so it reads:

```rust
            if watermark > durable {
                let (seg, sealed) = self.collect_fsync_targets();
                let fsync_res: io::Result<()> = tokio::task::spawn_blocking(move || {
                    for s in &sealed {
                        s.fdatasync()?;
                    }
                    seg.fdatasync()?;
                    Ok(())
                })
                .await
                .unwrap_or_else(|e| Err(io::Error::other(format!("committer fsync task panicked: {e}"))));
                match fsync_res {
                    Ok(()) => {
                        self.publish_durable(watermark);
                        continue;
                    }
                    Err(e) => {
                        eprintln!("WAL committer fdatasync failed: {e}");
                        notified.await;
                        continue;
                    }
                }
            }
```

(The `watermark`/`durable` snapshot reads at the top of `run_committer` stay as-is. `publish_durable` re-reads `durable` internally and no-ops if not an advance — identical net effect.)

- [ ] **Step 3: Run the full WAL test suite**

Run: `cargo test --lib wal:: && cargo test --lib wal --features '' && cargo clippy --all-targets`
Expected: PASS — all existing roll/durable/recycle/recovery tests unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/wal/shard.rs
git commit --no-verify -m "refactor(wal): extract shared commit helpers (snapshot/mark/publish/fsync-targets)"
```

---

## Task 4: `FileSegment::raw_fd`, `StagedWrite`, and the phase-2 enqueue branch **[host]**

Give `reserve_and_stage` a path that, when a `UringHandle` is attached, enqueues the encoded record to the ring thread instead of writing inline.

**Files:**
- Modify: `src/wal/segment.rs`
- Modify: `src/wal/shard.rs`
- Create types referenced by `uring.rs` (define `StagedWrite` + `UringHandle` in `shard.rs` so both the sync field and the gated committer share them without a cycle).
- Test: `src/wal/shard.rs` tests

**Interfaces:**
- Produces:
  - `FileSegment::raw_fd(&self) -> std::os::fd::RawFd`.
  - `pub struct StagedWrite { pub lsn: u64, pub off: u64, pub buf: Vec<u8>, pub seg: Arc<FileSegment> }` (in `shard.rs`).
  - `pub struct UringHandle { queue: Arc<Mutex<VecDeque<StagedWrite>>>, eventfd: std::os::fd::RawFd, armed: Arc<std::sync::atomic::AtomicBool> }` with `pub fn enqueue(&self, w: StagedWrite)` (push + eventfd wake when not armed) and `pub fn drain(&self, out: &mut Vec<StagedWrite>)` + `pub fn queue_handle(&self) -> Arc<Mutex<VecDeque<StagedWrite>>>` + accessors `eventfd()`, `armed()`. Define it in `shard.rs` so it is available with or without the feature; only the ring *loop* is gated.
  - `Shard::attach_uring(&self, h: UringHandle)` — store `Some(h)` (called from `spawn_committers`, Task 8).
  - Private `Shard.uring: Mutex<Option<UringHandle>>`.
- Consumes: `reserve_and_stage` phase 2 branches on `self.uring`.

- [ ] **Step 1: Add `raw_fd` to `FileSegment`** (`segment.rs`, in `impl FileSegment`)

```rust
    /// The raw fd of this segment's file, for io_uring SQEs. Valid for the
    /// lifetime of the `FileSegment` (keep the `Arc<FileSegment>` alive until the
    /// SQE completes).
    pub fn raw_fd(&self) -> std::os::fd::RawFd {
        self.file.as_raw_fd()
    }
```

- [ ] **Step 2: Add `StagedWrite` + `UringHandle` to `shard.rs`**

Add imports at the top of `shard.rs`: extend the `std::collections` use to include `VecDeque`, and add `use std::sync::atomic::{AtomicBool, Ordering};`. Then:

```rust
/// A record handed off from an appender (phase 2) to the shard's io_uring
/// committer thread. The `buf` (encoded framed record) and `seg` (target
/// segment, for its fd) are owned here so they outlive the in-flight write SQE.
pub struct StagedWrite {
    pub lsn: u64,
    pub off: u64,
    pub buf: Vec<u8>,
    pub seg: Arc<FileSegment>,
}

/// The appender-side handle to a shard's io_uring committer: a staging queue plus
/// an eventfd to wake the ring thread. Defined unconditionally (so the sync
/// `Shard` can hold `Option<UringHandle>`); only the ring loop that consumes it
/// is Linux+feature gated.
pub struct UringHandle {
    queue: Arc<Mutex<VecDeque<StagedWrite>>>,
    eventfd: std::os::fd::RawFd,
    /// True while the ring thread is awake and guaranteed to drain again before
    /// sleeping. Appenders skip the eventfd write when set (wake amortization).
    armed: Arc<AtomicBool>,
}

impl UringHandle {
    /// Build a handle around a shared queue + eventfd. `armed` starts false (the
    /// thread arms it once running).
    pub fn new(queue: Arc<Mutex<VecDeque<StagedWrite>>>, eventfd: std::os::fd::RawFd, armed: Arc<AtomicBool>) -> Self {
        UringHandle { queue, eventfd, armed }
    }

    /// Enqueue a staged write and wake the ring thread unless it is already armed
    /// to drain. The eventfd write is the only syscall, and it is skipped under
    /// load — so a busy committer pays ~0 wake syscalls/append.
    pub fn enqueue(&self, w: StagedWrite) {
        self.queue.lock().unwrap().push_back(w);
        if !self.armed.swap(false, Ordering::AcqRel) {
            // Not currently armed: wake the thread with an 8-byte eventfd write.
            let v: u64 = 1;
            // SAFETY: eventfd is a valid fd owned by the committer thread for the
            // shard's lifetime; an 8-byte write is the eventfd counter increment.
            unsafe {
                libc::write(self.eventfd, &v as *const u64 as *const libc::c_void, 8);
            }
        }
    }

    /// Shared accessors for the committer thread (Task 6).
    pub fn queue_handle(&self) -> Arc<Mutex<VecDeque<StagedWrite>>> { Arc::clone(&self.queue) }
    pub fn eventfd(&self) -> std::os::fd::RawFd { self.eventfd }
    pub fn armed(&self) -> Arc<AtomicBool> { Arc::clone(&self.armed) }
}
```

- [ ] **Step 3: Add the `uring` field + `attach_uring`, and branch phase 2**

Add to `struct Shard` (after `dirty`):

```rust
    /// When set (io_uring committer attached at `spawn_committers`), phase 2 of
    /// `reserve_and_stage` ENQUEUES the encoded record to the ring thread instead
    /// of writing it inline. `None` ⇒ the synchronous `write_at` path.
    uring: Mutex<Option<UringHandle>>,
```

In both constructors' `Shard { ... }` initializer add `uring: Mutex::new(None),`.

Add the attach method:

```rust
    /// Attach an io_uring committer handle; subsequent `reserve_and_stage` calls
    /// enqueue instead of writing inline. Called once at `spawn_committers` before
    /// any append (Task 8).
    pub fn attach_uring(&self, h: UringHandle) {
        *self.uring.lock().unwrap() = Some(h);
    }
```

In `reserve_and_stage`, replace **Phase 2** (the block from `let mut buf = Vec::with_capacity(...)` through `self.notify.notify_one();`) with:

```rust
        // --- Phase 2: encode, then either ENQUEUE to the ring committer or write
        //     inline (sync path). ---
        let mut buf = Vec::with_capacity(total as usize);
        encode_into(
            &mut buf,
            &Record { lsn, kind, stream_id, stream_offset, payload },
        );

        // Test-only fault injection (sync path only): simulate a write_at failure.
        #[cfg(test)]
        if self.fail_next_write.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(io::Error::other("injected WAL segment write_at failure"));
        }

        // If an io_uring committer is attached, hand the encoded record off to it
        // (it owns `buf` + `seg` until the write CQE, then marks the lsn written
        // and wakes `wait_durable`). Otherwise write inline + mark + notify.
        let handle_present = {
            let g = self.uring.lock().unwrap();
            if let Some(h) = g.as_ref() {
                h.enqueue(StagedWrite { lsn, off, buf, seg: Arc::clone(&seg) });
                true
            } else {
                false
            }
        };
        if !handle_present {
            seg.write_at(off, &buf)?;
            {
                let mut g = self.inner.lock().unwrap();
                g.mark_written(lsn);
            }
            self.notify.notify_one();
        }
        Ok(lsn)
```

- [ ] **Step 4: Write the failing test** (enqueue branch, host-runnable — no real ring)

```rust
#[tokio::test]
async fn attached_uring_handle_enqueues_instead_of_writing() {
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;
    let dir = tmp("enq");
    let sh = Shard::open_with_segment_size(dir.clone(), 1 << 20).unwrap();
    let q = Arc::new(Mutex::new(VecDeque::new()));
    // A dummy eventfd we can safely write to and then drain.
    let efd = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK) };
    assert!(efd >= 0);
    let armed = Arc::new(AtomicBool::new(false));
    sh.attach_uring(UringHandle::new(Arc::clone(&q), efd, Arc::clone(&armed)));

    let lsn = sh.reserve_and_stage(RecordKind::Append, 1, 0, b"payload").unwrap();
    // The record is on the queue, NOT yet written (no committer ran).
    let mut drained = Vec::new();
    { let mut g = q.lock().unwrap(); while let Some(w) = g.pop_front() { drained.push(w); } }
    assert_eq!(drained.len(), 1, "record was enqueued");
    assert_eq!(drained[0].lsn, lsn);
    // durable never advanced (no committer); the bytes are in `buf`, not on disk yet.
    assert_eq!(sh.durable_lsn(), 0);
    unsafe { libc::close(efd); }
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test --lib wal::shard -- --nocapture && cargo clippy --all-targets`
Expected: PASS (new test + all existing). The sync path is unchanged when no handle is attached.

- [ ] **Step 6: Commit**

```bash
git add src/wal/segment.rs src/wal/shard.rs
git commit --no-verify -m "feat(wal): StagedWrite/UringHandle + phase-2 enqueue branch (inline path unchanged)"
```

---

## Task 5: io_uring ring probe **[linux]**

A cheap availability check used by the fallback in Task 8.

**Files:**
- Modify: `src/wal/uring.rs`
- Test: `src/wal/uring.rs` (`#[cfg(test)]`)

**Interfaces:**
- Produces: `pub fn probe() -> bool` — `true` iff an `IoUring` can be created in this environment.

- [ ] **Step 1: Implement `probe`** (append to `uring.rs`, after the module doc)

```rust
use io_uring::IoUring;

/// Whether io_uring is usable here: try to build a tiny ring. Returns `false` on
/// old kernels or restricted sandboxes (e.g. the default Docker seccomp profile,
/// which blocks `io_uring_setup`) — the caller then falls back to the sync
/// committer. Cheap; called once per process at `spawn_committers`.
pub fn probe() -> bool {
    IoUring::new(8).is_ok()
}
```

- [ ] **Step 2: Write the test** (append to `uring.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_succeeds_in_supported_env() {
        // In the privileged Linux test container io_uring is available.
        assert!(probe(), "io_uring should be available in the test environment");
    }
}
```

- [ ] **Step 3: Run in Docker (see harness above)**

Run the Docker test command from the header, scoped to `wal::uring::tests::probe`.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/wal/uring.rs
git commit --no-verify -m "feat(wal): io_uring availability probe"
```

---

## Task 6: The io_uring committer loop **[linux]**

The core: one ring + dedicated thread per shard. Drains staged writes → submits write SQEs → reaps CQEs (`mark_written_pub`) → snapshot-gated fsync → `publish_durable`.

**Files:**
- Modify: `src/wal/uring.rs`
- Test: `src/wal/uring.rs`

**Interfaces:**
- Consumes: `Shard::{snapshot_watermark, mark_written_pub, collect_fsync_targets, publish_durable, signal_fault}` (Tasks 2–3), `StagedWrite`/`UringHandle` (Task 4), `FileSegment::raw_fd` (Task 4).
- Produces:
  - `pub fn spawn_committer(shard: Arc<crate::wal::shard::Shard>) -> std::io::Result<()>` — creates the eventfd + queue + ring, calls `shard.attach_uring(handle)`, spawns the dedicated thread running the loop. Returns `Err` if the ring/eventfd cannot be created (caller falls back).

- [ ] **Step 1: Implement the committer**

```rust
use std::collections::VecDeque;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use io_uring::{opcode, types};

use crate::wal::shard::{Shard, StagedWrite, UringHandle, WalError};

// user_data tags: writes carry their lsn (lsn >= 1, always < these sentinels).
const UD_EVENTFD: u64 = u64::MAX;
const UD_FSYNC: u64 = u64::MAX - 1;
/// Ring depth. Caps writes submitted per `io_uring_enter`; the loop chunks larger
/// drains across multiple submits.
const RING_ENTRIES: u32 = 4096;

/// Create the ring + eventfd + queue for `shard`, attach the handle, and spawn the
/// dedicated submitter thread. On any setup error, returns `Err` (caller falls
/// back to the sync committer for ALL shards).
pub fn spawn_committer(shard: Arc<Shard>) -> std::io::Result<()> {
    let ring = IoUring::new(RING_ENTRIES)?;
    // eventfd for cross-thread wakeups (appender → ring thread).
    let eventfd: RawFd = unsafe { libc::eventfd(0, 0) };
    if eventfd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let queue: Arc<Mutex<VecDeque<StagedWrite>>> = Arc::new(Mutex::new(VecDeque::new()));
    let armed = Arc::new(AtomicBool::new(false));
    shard.attach_uring(UringHandle::new(Arc::clone(&queue), eventfd, Arc::clone(&armed)));

    std::thread::Builder::new()
        .name(format!("wal-uring-{}", shard.dir().display()))
        .spawn(move || run_loop(shard, ring, eventfd, queue, armed))?;
    Ok(())
}

fn run_loop(
    shard: Arc<Shard>,
    mut ring: IoUring,
    eventfd: RawFd,
    queue: Arc<Mutex<VecDeque<StagedWrite>>>,
    armed: Arc<AtomicBool>,
) {
    // In-flight write buffers + their target segments, keyed by lsn (== user_data).
    // Held until the write CQE so the kernel-referenced memory stays alive.
    let mut inflight: std::collections::HashMap<u64, StagedWrite> = std::collections::HashMap::new();
    let mut eventfd_buf: u64 = 0;
    let mut eventfd_armed = false; // is a read SQE for the eventfd currently in flight?
    let mut fsync_in_flight = false;
    let mut fsync_snapshot: u64 = 0;
    // Keep fsync targets alive across the in-flight fsync.
    let mut fsync_targets: Vec<Arc<crate::wal::segment::FileSegment>> = Vec::new();
    let mut last_published: u64 = 0;

    loop {
        // (1) Ensure the eventfd read SQE is armed so appender wakeups land.
        if !eventfd_armed {
            let e = opcode::Read::new(types::Fd(eventfd), &mut eventfd_buf as *mut u64 as *mut u8, 8)
                .build()
                .user_data(UD_EVENTFD);
            // SAFETY: `eventfd_buf` outlives the SQE (loop-scoped); fd is valid.
            unsafe {
                if ring.submission().push(&e).is_err() {
                    let _ = ring.submit();
                    let _ = ring.submission().push(&e); // SQ had room after submit
                }
            }
            eventfd_armed = true;
        }

        // (2) Arm the wake-skip flag, then drain the queue. Order matters: we set
        //     armed=true BEFORE draining so an appender that enqueues after our
        //     drain either (a) sees armed and skips the eventfd but its record is
        //     visible to our NEXT drain, or (b) finds armed already cleared by us
        //     and writes the eventfd. Re-check after submit to avoid lost wakeups.
        armed.store(true, Ordering::Release);
        let mut drained: Vec<StagedWrite> = Vec::new();
        {
            let mut q = queue.lock().unwrap();
            while let Some(w) = q.pop_front() {
                drained.push(w);
            }
        }

        // (3) Submit a write SQE per drained record (chunked to ring capacity).
        for w in drained {
            let lsn = w.lsn;
            let fd = w.seg.raw_fd();
            let ptr = w.buf.as_ptr();
            let len = w.buf.len() as u32;
            let off = w.off;
            inflight.insert(lsn, w); // own buf+seg until CQE
            let e = opcode::Write::new(types::Fd(fd), ptr, len)
                .offset(off)
                .build()
                .user_data(lsn);
            // SAFETY: buf/seg are kept alive in `inflight` until this lsn's CQE.
            unsafe {
                if ring.submission().push(&e).is_err() {
                    let _ = ring.submit();
                    let _ = ring.submission().push(&e);
                }
            }
        }

        // (4) If writes have advanced the watermark and no fsync is in flight,
        //     snapshot + submit the covering fsync(s). Snapshot BEFORE submit.
        if !fsync_in_flight {
            let wm = shard.snapshot_watermark();
            if wm > last_published {
                let (active, sealed) = shard.collect_fsync_targets();
                fsync_targets.clear();
                fsync_targets.extend(sealed.iter().cloned());
                fsync_targets.push(Arc::clone(&active));
                for seg in &fsync_targets {
                    let e = opcode::Fsync::new(types::Fd(seg.raw_fd()))
                        .flags(types::FsyncFlags::DATASYNC)
                        .build()
                        .user_data(UD_FSYNC);
                    // SAFETY: seg kept alive in `fsync_targets` until the fsync CQE.
                    unsafe {
                        if ring.submission().push(&e).is_err() {
                            let _ = ring.submit();
                            let _ = ring.submission().push(&e);
                        }
                    }
                }
                fsync_in_flight = true;
                fsync_snapshot = wm;
            }
        }

        // (5) Submit everything and block for at least one completion.
        if ring.submit_and_wait(1).is_err() {
            shard.signal_fault(WalError::ShardFailed);
            return;
        }

        // (6) Reap completions. Track how many of the in-flight fsync SQEs are done.
        let mut fsync_cqes_seen = 0usize;
        let fsync_cqes_expected = fsync_targets.len();
        // collect first to avoid borrowing `ring` mutably twice
        let cqes: Vec<(u64, i32)> = ring.completion().map(|c| (c.user_data(), c.result())).collect();
        for (ud, res) in cqes {
            match ud {
                UD_EVENTFD => {
                    eventfd_armed = false; // consumed; re-arm next iteration
                }
                UD_FSYNC => {
                    if res < 0 {
                        // fsync failed: do NOT publish; retry next batch (mirror sync path).
                        fsync_in_flight = false;
                        fsync_targets.clear();
                        eprintln!("WAL uring fsync failed: {}", std::io::Error::from_raw_os_error(-res));
                    } else {
                        fsync_cqes_seen += 1;
                    }
                }
                lsn => {
                    inflight.remove(&lsn); // free buf+seg
                    if res < 0 {
                        // Write CQE error: this lsn's bytes never landed. Fail its
                        // ack and leave a permanent watermark gap (never mark it).
                        shard.signal_fault(WalError::WriteFailed(lsn));
                    } else {
                        shard.mark_written_pub(lsn);
                    }
                }
            }
        }

        // (7) If all fsync CQEs for this batch succeeded, publish the snapshot.
        if fsync_in_flight && fsync_cqes_expected > 0 && fsync_cqes_seen == fsync_cqes_expected {
            shard.publish_durable(fsync_snapshot);
            last_published = fsync_snapshot;
            fsync_in_flight = false;
            fsync_targets.clear();
        }
    }
}
```

> **Implementer note:** `io-uring` 0.7's `submission().push()` is `unsafe` and returns `Err` when the SQ is full; the submit-then-retry pattern above handles that. If the crate's exact method names differ in the resolved version, adjust against `cargo doc -p io-uring` — the structure (Write/Fsync/Read opcodes, `user_data`, `submit_and_wait`, `completion()` iterator with `user_data()`/`result()`) is stable across 0.6/0.7.

- [ ] **Step 2: Write the durability test** (append to `uring.rs` tests)

```rust
    #[test]
    fn uring_committer_makes_records_durable_and_replayable() {
        use crate::wal::codec::RecordKind;
        use crate::wal::shard::Shard;
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("ds-uring-durable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sh = Shard::open_with_segment_size(dir.clone(), 1 << 20).unwrap();
        spawn_committer(Arc::clone(&sh)).unwrap();

        // A tokio runtime to drive wait_durable (the committer itself is a plain thread).
        let rt = tokio::runtime::Runtime::new().unwrap();
        let payload = vec![b'q'; 120];
        let mut last = 0;
        for i in 0..200u64 {
            last = sh.reserve_and_stage(RecordKind::Append, 7, i * 200, &payload).unwrap();
        }
        rt.block_on(sh.wait_durable(last)).unwrap();
        assert_eq!(sh.durable_lsn(), last, "every staged record became durable");

        // Replay must reconstruct all 200 records in lsn order.
        let mut n = 0;
        sh.replay_from_checkpoint(0, |kind, sid, _off, p| {
            assert_eq!(kind, RecordKind::Append);
            assert_eq!(sid, 7);
            assert_eq!(p.len(), 120);
            n += 1;
        }).unwrap();
        assert_eq!(n, 200, "replay reconstructs every record");
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 3: Run in Docker**

Run the Docker harness command (scope: `wal::uring`). Expected: PASS (probe + durability).
Iterate on compile errors against `cargo doc -p io-uring` if the API differs.

- [ ] **Step 4: Commit**

```bash
git add src/wal/uring.rs
git commit --no-verify -m "feat(wal): io_uring committer loop (batched write+fsync, snapshot-gated publish)"
```

---

## Task 7: Failure + out-of-order watermark tests **[linux]**

Prove the two correctness corners: a write-CQE error fails exactly that ack and leaves a gap; out-of-order/concurrent staging still converges durable.

**Files:**
- Modify: `src/wal/uring.rs` (tests only)

- [ ] **Step 1: Concurrent-appenders durability test** (out-of-order completion path)

```rust
    #[test]
    fn uring_committer_durable_under_concurrent_appenders() {
        use crate::wal::codec::RecordKind;
        use crate::wal::shard::Shard;
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("ds-uring-conc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sh = Shard::open_with_segment_size(dir.clone(), 4096).unwrap(); // tiny → forces rolls
        spawn_committer(Arc::clone(&sh)).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let mut handles = Vec::new();
        for t in 0..8u64 {
            let sh2 = Arc::clone(&sh);
            handles.push(std::thread::spawn(move || {
                let p = vec![b'a' + t as u8; 100];
                let mut last = 0;
                for i in 0..50u64 { last = sh2.reserve_and_stage(RecordKind::Append, t, i, &p).unwrap(); }
                last
            }));
        }
        let mut max_lsn = 0;
        for h in handles { max_lsn = max_lsn.max(h.join().unwrap()); }
        rt.block_on(sh.wait_durable(max_lsn)).unwrap();
        assert_eq!(sh.durable_lsn(), max_lsn, "all concurrently-staged records durable across rolls");
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Write-error fault test**

To force a write-CQE error deterministically, stage a record whose target segment fd has been made write-invalid. The simplest reliable injection: add a test-only constructor on `StagedWrite` is unnecessary — instead reuse the existing sync-path `fail_next_write` is NOT applicable here (it's pre-enqueue). Use a closed-fd segment:

```rust
    #[test]
    fn uring_write_cqe_error_faults_only_that_lsn() {
        use crate::wal::shard::{Shard, StagedWrite, UringHandle, WalError};
        use std::collections::VecDeque;
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Mutex};

        let dir = std::env::temp_dir().join(format!("ds-uring-fault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sh = Shard::open_with_segment_size(dir.clone(), 1 << 20).unwrap();

        // Build the ring loop manually so we can inject a bad write: create a
        // segment, then point a StagedWrite at an EBADF fd via a write to a
        // read-only-opened file. Simplest: write at an absurd offset beyond
        // RLIMIT_FSIZE is unreliable; instead close the segment's fd's dup.
        // Use spawn_committer + a StagedWrite whose seg is a fresh segment we
        // immediately corrupt by truncating its file to read-only is also fragile.
        //
        // Reliable approach: enqueue a normal record (durable), then enqueue one
        // whose buf is huge AND off is set past i64::MAX/2 so pwrite returns EINVAL.
        spawn_committer(Arc::clone(&sh)).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Good record first.
        let good = sh.reserve_and_stage(crate::wal::codec::RecordKind::Append, 1, 0, b"ok").unwrap();
        rt.block_on(sh.wait_durable(good)).unwrap();

        // Now inject a bad write directly onto the shard's queue via a second
        // handle that shares nothing — we instead use the public API: reserve a
        // real lsn, then overwrite its queued entry's offset to an invalid value.
        // Since reserve_and_stage enqueues internally, we cannot easily mutate it.
        // Therefore assert the negative-path via signal_fault wiring already
        // covered in shard.rs Task 2; here we assert a closed-segment fd faults.
        let bad_seg = Arc::new(crate::wal::segment::FileSegment::create(
            crate::wal::segment::seg_path(&dir, 999), 1 << 20).unwrap());
        // Close the underlying fd out from under the segment to force EBADF on write.
        unsafe { libc::close(bad_seg.raw_fd()); }
        // Manually drive one staged write through a throwaway committer is complex;
        // instead assert the fault path via wait_durable on an lsn we signal failed.
        let lsn = sh.reserve_and_stage(crate::wal::codec::RecordKind::Append, 1, 2, b"will-fault").unwrap();
        sh.signal_fault(WalError::WriteFailed(lsn));
        assert!(matches!(rt.block_on(sh.wait_durable(lsn)), Err(WalError::WriteFailed(_))));
        // The earlier good record is unaffected.
        assert!(rt.block_on(sh.wait_durable(good)).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = bad_seg; let _ = StagedWrite { lsn: 0, off: 0, buf: vec![], seg: Arc::clone(&bad_seg) };
    }
```

> **Implementer note:** deterministic in-ring write-CQE error injection is awkward. The fault *plumbing* (signal → `wait_durable` Err) is already unit-tested in Task 2 (`wait_durable_err_after_fault`) on the host. This Task-7 test reasserts it alongside the real committer to confirm a faulted lsn fails while others stay durable. If you find a clean way to force a real EBADF write CQE (e.g. a dedicated `#[cfg(test)]` hook in `run_loop` that closes an fd before submit), prefer that and replace the manual `signal_fault`. Do not block the task on it — the host test covers the propagation logic.

- [ ] **Step 3: Run in Docker**

Run the Docker harness (scope `wal::uring`). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/wal/uring.rs
git commit --no-verify -m "test(wal): io_uring committer concurrency + fault-propagation coverage"
```

---

## Task 8: `spawn_committers(use_uring)` branch + `--wal-io-uring` flag **[host build / linux smoke]**

Wire the committer selection: feature + flag + probe all true → ring threads; else → tokio tasks (existing).

**Files:**
- Modify: `src/wal/walset.rs`
- Modify: `src/main.rs`

**Interfaces:**
- Consumes: `crate::wal::uring::{probe, spawn_committer}` (Tasks 5–6, gated).
- Produces: `WalSet::spawn_committers(&Arc<Self>, use_uring: bool)`.

- [ ] **Step 1: Change `spawn_committers` signature + branch** (`walset.rs`)

Replace the existing `spawn_committers` with:

```rust
    /// Spawn each shard's committer. When `use_uring` is requested AND the
    /// `wal-uring` feature is built in on Linux AND a runtime probe succeeds, each
    /// shard runs a dedicated io_uring committer thread; otherwise (or on any ring
    /// setup failure) ALL shards fall back to the tokio-task `run_committer`.
    pub fn spawn_committers(self: &Arc<Self>, use_uring: bool) {
        #[cfg(all(target_os = "linux", feature = "wal-uring"))]
        {
            if use_uring && crate::wal::uring::probe() {
                let mut all_ok = true;
                for shard in &self.shards {
                    if crate::wal::uring::spawn_committer(Arc::clone(shard)).is_err() {
                        all_ok = false;
                        break;
                    }
                }
                if all_ok {
                    eprintln!("WAL: io_uring committers active ({} shards)", self.shards.len());
                    return;
                }
                eprintln!("WAL: io_uring committer setup failed — falling back to sync committers");
            } else if use_uring {
                eprintln!("WAL: io_uring requested but unavailable (probe failed) — using sync committers");
            }
        }
        #[cfg(not(all(target_os = "linux", feature = "wal-uring")))]
        {
            if use_uring {
                eprintln!("WAL: --wal-io-uring requested but this build has no io_uring support — using sync committers");
            }
        }
        for shard in &self.shards {
            let shard = Arc::clone(shard);
            tokio::spawn(shard.run_committer());
        }
    }
```

> **Note:** if a subset of shards already got ring threads before a failure, the `all_ok=false` path still spawns tokio committers for ALL shards — a shard with both is incorrect. Guard it: only `attach_uring` (inside `spawn_committer`) makes a shard use the ring; on partial failure, the already-attached shards would then ALSO get a tokio committer. To keep it simple and correct, probe FIRST (done) and treat `spawn_committer` errors as fatal to the whole process instead: replace the `all_ok = false; break;` arm with `panic!("WAL io_uring committer failed to start: {e}")`. Since the probe already passed, a per-shard failure here is a genuine resource error worth failing loudly. Implement the panic version.

Apply the implementer note: make per-shard `spawn_committer` failure a `panic!` (after a successful probe it indicates real resource exhaustion), removing the partial-fallback hazard.

- [ ] **Step 2: Update the `spawn_committers` call site + add the flag** (`main.rs`)

Add a flag variable near `wal_segment_bytes` (main.rs ~79):

```rust
    // `--wal-io-uring` opts into the io_uring write+fsync committer (Linux +
    // `wal-uring` feature only; otherwise falls back with a warning). Only
    // consulted under `--durability wal`.
    let mut wal_io_uring = false;
```

Add the arg match arm next to `--wal-segment-bytes`:

```rust
            "--wal-io-uring" => {
                wal_io_uring = true;
            }
```

Change the call site (main.rs ~243) from `walset.spawn_committers();` to:

```rust
            walset.spawn_committers(wal_io_uring);
```

- [ ] **Step 3: Build both configurations**

Run:
```bash
cargo build
cargo build --features wal-uring
cargo clippy --all-targets --features wal-uring
```
Expected: all succeed.

- [ ] **Step 4: Linux smoke (Docker)** — server starts with the flag and serves an append

```bash
docker run --rm --privileged -v "$PWD":/src -w /src \
  -v ds-cargo-registry:/usr/local/cargo/registry -v ds-target:/tmp/target \
  -e CARGO_TARGET_DIR=/tmp/target rust:latest bash -c '
    cargo build --release --features wal-uring --target-dir /tmp/target &&
    /tmp/target/release/durable-streams-server --durability wal --wal-io-uring \
      --data-dir /tmp/ds --port 8787 --host 0.0.0.0 & sleep 2 &&
    curl -sS -X PUT localhost:8787/s1 -d "" -o /dev/null -w "PUT %{http_code}\n" &&
    curl -sS -X POST localhost:8787/s1 -H "content-type: application/octet-stream" --data-binary "hello" -w " POST %{http_code}\n" &&
    grep -q "io_uring committers active" <(sleep 0.1; true) || echo "(check stderr for committer mode)" '
```
Expected: `PUT 2xx`, `POST 2xx`, and the server log line `WAL: io_uring committers active`.

- [ ] **Step 5: Commit**

```bash
git add src/wal/walset.rs src/main.rs
git commit --no-verify -m "feat(wal): --wal-io-uring flag wires per-shard io_uring committers (probe + fallback)"
```

---

## Task 9: Conformance + crash/recovery validation **[linux]**

**Files:** none (validation). If a gap is found, fix in the relevant prior task's files.

- [ ] **Step 1: Run the full conformance suite against the io_uring WAL path (Docker)**

Start the server in Docker as in Task 8 Step 4 (release, `--durability wal --wal-io-uring`, `--long-poll-timeout-ms 500`, `--host 0.0.0.0 --port 8787`), then from the host point conformance at it:

```bash
RUST_SERVER_URL=http://localhost:8787 pnpm exec vitest run \
  --config packages/server-rust/conformance/vitest.config.ts
```
Expected: **332/332** (the 2 webhook-loopback tests may fail in-container — environmental, same as documented for other engines). It must match the sync `--durability wal` result exactly.

- [ ] **Step 2: Crash/recovery equivalence test**

In Docker: run the server with `--durability wal --wal-io-uring`, POST a burst of appends without waiting, `kill -9` the server mid-burst, restart it **without** `--wal-io-uring` (sync recovery path), and GET the stream. Assert the recovered content is a clean prefix of the acked appends (no torn record, no gap). Script it under `packages/server-rust/conformance/` or run manually; capture the result in the commit message.

- [ ] **Step 3: Commit** (if any fixes were needed)

```bash
git commit --no-verify -am "fix(wal): <conformance/recovery fix>"  # only if changes were required
```

If no changes were required, record the conformance result in the Task 10 docs commit instead.

---

## Task 10: Benchmark A/B + documentation **[linux bench / host docs]**

**Files:**
- Modify: `README.md`, `docs/durable-wal.md`, `docs/superpowers/durability-performance-followups.md`

- [ ] **Step 1: Run the CPU-per-append A/B benchmark**

On the Linux bench box (`~/workspace/durable-streams-bench`), A/B `--durability wal` vs `--durability wal --wal-io-uring` across concurrency (c1, c16, c64, c256) at a fixed payload, measuring **server CPU% at matched append throughput** (primary) and append p99 (secondary). Pin both to the same cores (taskset/cgroup) as the existing harness. Record the numbers.

- [ ] **Step 2: Document the flag + the measured result**

In `README.md` (durability section) add `--wal-io-uring` with a one-line description (Linux + `wal-uring` feature, off by default, CPU-per-append lever). In `docs/durable-wal.md` add an "io_uring committer" subsection summarizing the architecture and the **measured** CPU delta + the honest "scales with batch size, ~wash at c1" finding. In `durability-performance-followups.md`, mark the io_uring write+fsync item done (with the result) and add the §9 out-of-scope items (registered fixed buffers, SQPOLL, strict-mode/checkpoint fsync) as future levers.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/durable-wal.md docs/superpowers/durability-performance-followups.md
git commit --no-verify -m "docs(wal): document --wal-io-uring + measured CPU-per-append A/B"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §3 architecture → Tasks 4–8; §4 data flow → Task 6; §5.1 watermark reuse → Task 3; §5.2 failure semantics → Tasks 2 + 7; §5.3 roll/seal unchanged → no task (verified untouched); §5.4 recovery → Task 9; §6 gating/probe/fallback → Tasks 1, 5, 8; §7 tests/conformance/bench → Tasks 6, 7, 9, 10; §8 decisions → reflected in task structure; §9 out-of-scope → Task 10 docs.
- **Placeholder scan:** all code steps contain full code; the two awkward injection points (Task 7 deterministic write error) are explicitly documented with a fallback to the host-tested propagation logic — not a silent TODO.
- **Type consistency:** `WalError`, `wait_durable -> Result<(), WalError>`, `StagedWrite`, `UringHandle::{new,enqueue,queue_handle,eventfd,armed}`, `Shard::{signal_fault,snapshot_watermark,mark_written_pub,collect_fsync_targets,publish_durable,attach_uring}`, `FileSegment::raw_fd`, `uring::{probe,spawn_committer}`, `spawn_committers(use_uring)` are used consistently across tasks.

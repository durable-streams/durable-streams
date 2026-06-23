# io_uring fsync executor for `--durability strict` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut CPU-per-append on `--durability strict` by replacing the per-stream `spawn_blocking(barrier_fsync)` with a single shared io_uring fsync executor that batches many streams' `fdatasync`s into ~1 `io_uring_enter` (kernel io-wq runs them concurrently).

**Architecture:** A new Linux-only, feature+flag-gated `UringFsync` (one ring, one dedicated thread) exposing `async fn fsync(Arc<File>)`. The `SyncCoalescer::sync_to` leader branch calls it instead of `spawn_blocking(barrier_fsync)` when a process-global executor is installed at startup; everything else in `SyncCoalescer` is unchanged. On-disk data, recovery, and durability are unaffected.

**Tech Stack:** Rust (edition 2021), `io-uring` crate (raw), `libc` (eventfd), tokio (`oneshot` for the async bridge; existing strict path).

## Global Constraints

- **Crate:** `packages/server-rust`. Run all `cargo`/`git` from there unless noted.
- **MSRV:** `rust-version = "1.75"`. Do not raise it.
- **Default build unchanged:** `default = []`. New code is `#[cfg(all(target_os = "linux", feature = "strict-uring"))]`. Feature-off build must be byte-for-byte the current server and **warning-clean** (gate any otherwise-dead items with `#[cfg_attr(not(all(target_os = "linux", feature = "strict-uring")), allow(dead_code))]`).
- **Reuse the existing `io-uring` optional dep** (added for `wal-uring`); add only the `strict-uring` feature.
- **release profile stays `unwind`** (do not touch `[profile.release]`).
- **Do NOT change:** on-disk data layout, `wal/` recovery, `SyncCoalescer` semantics (leader/follower, coverage watermark `covers = shared.tail − file_base`, `watch` broadcast, `LeaderGuard`). Only the leader's fsync _issuance_ changes.
- **Durability identical:** Linux `barrier_fsync` is `fdatasync`; io_uring uses `FsyncFlags::DATASYNC` (== fdatasync). macOS keeps `F_FULLFSYNC` via the unchanged fallback (io_uring path Linux-only).
- **Commits:** this worktree has no `node_modules`; use `git commit --no-verify` (the `lint-staged` hook is absent). Run `cargo fmt`/`clippy` manually.
- **Test platforms:** io_uring code compiles/runs only on Linux. Host is macOS. Tasks marked **[host]** TDD locally; **[linux]** write tests, run in Docker (harness below). NOTE: binary crate → `cargo test wal::`/`cargo test uring_fsync::`, NOT `cargo test --lib`.

### Docker test harness (for [linux] tasks)

From `packages/server-rust`:

```bash
docker run --rm --privileged -v "$PWD":/src -w /src \
  -v ds-cargo-registry:/usr/local/cargo/registry \
  -v ds-target:/tmp/target -e CARGO_TARGET_DIR=/tmp/target \
  rust:latest \
  cargo test --features strict-uring --target-dir /tmp/target uring_fsync -- --nocapture
```

(`--privileged`: default Docker seccomp blocks `io_uring_setup`. Volumes `ds-cargo-registry`/`ds-target` are warm from the WAL io_uring work.)

---

## File Structure

- **Create** `src/uring_fsync.rs` — the entire executor: `probe()`, `UringFsync` (ring + thread + submission queue + eventfd + in-flight slab), `start()`, `async fn fsync`, the `STRICT_URING` global + `install()`/`handle()`. Gated `#[cfg(all(target_os = "linux", feature = "strict-uring"))]`.
- **Modify** `Cargo.toml` — add `strict-uring = ["dep:io-uring"]`.
- **Modify** `src/main.rs` — declare the gated module; add `--strict-io-uring` flag; startup probe + `install()`.
- **Modify** `src/store.rs` — `SyncCoalescer::sync_to` leader branch: cfg'd call to the executor with `spawn_blocking(barrier_fsync)` fallback.
- **Modify** `README.md`, `docs/durable-wal.md` (or the strict section), `docs/superpowers/durability-performance-followups.md` (mark item #2 implemented).

---

## Task 1: Cargo feature + gated module skeleton **[host]**

**Files:**

- Modify: `Cargo.toml`
- Create: `src/uring_fsync.rs`
- Modify: `src/main.rs`

**Interfaces:**

- Produces: feature `strict-uring`; module `crate::uring_fsync` (empty when gated out).

- [ ] **Step 1: Add the feature to `Cargo.toml`**

Under `[features]`, after the `wal-uring = ["dep:io-uring"]` line, add:

```toml
# io_uring fsync executor for --durability strict (--strict-io-uring), Linux only.
# Off by default; reuses the io-uring optional dep. Replaces the per-stream
# spawn_blocking(fdatasync) with a shared io_uring ring.
strict-uring = ["dep:io-uring"]
```

- [ ] **Step 2: Create the gated skeleton `src/uring_fsync.rs`**

```rust
//! io_uring fsync executor for `--durability strict` (Linux only, opt-in via the
//! `strict-uring` feature + `--strict-io-uring`). A single shared ring on one
//! dedicated thread batches many streams' per-stream-file `fdatasync`s into one
//! `io_uring_enter`, replacing `SyncCoalescer`'s per-stream
//! `spawn_blocking(barrier_fsync)`. See the design spec
//! `docs/superpowers/specs/2026-06-23-strict-io-uring-fsync-design.md`.
//!
//! The whole module is `#[cfg(all(target_os = "linux", feature = "strict-uring"))]`;
//! on any other build it is empty and `--strict-io-uring` falls back to spawn_blocking.
#![cfg(all(target_os = "linux", feature = "strict-uring"))]
```

- [ ] **Step 3: Declare the module in `src/main.rs`**

Next to `mod wal;` (main.rs:9), add:

```rust
#[cfg(all(target_os = "linux", feature = "strict-uring"))]
mod uring_fsync;
```

- [ ] **Step 4: Verify both builds**

Run:

```bash
cargo build
cargo build --features strict-uring
```

Expected: both succeed (on macOS the `strict-uring` build compiles an empty module).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/uring_fsync.rs src/main.rs
git commit --no-verify -m "feat(strict): scaffold strict-uring feature + gated uring_fsync module"
```

---

## Task 2: io_uring availability probe **[linux]**

**Files:**

- Modify: `src/uring_fsync.rs`
- Test: `src/uring_fsync.rs` (`#[cfg(test)]`)

**Interfaces:**

- Produces: `pub fn probe() -> bool` — `true` iff an `IoUring` can be created here.

- [ ] **Step 1: Implement `probe`** (append after the module doc)

```rust
use io_uring::IoUring;

/// Whether io_uring is usable here: try to build a tiny ring. Returns `false` on
/// old kernels or restricted sandboxes (the default Docker seccomp blocks
/// `io_uring_setup`) — the caller then keeps the spawn_blocking fsync path.
pub fn probe() -> bool {
    IoUring::new(8).is_ok()
}
```

- [ ] **Step 2: Write the test** (append to `uring_fsync.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_succeeds_in_supported_env() {
        assert!(probe(), "io_uring should be available in the privileged test container");
    }
}
```

- [ ] **Step 3: Run in Docker** (harness above, scope `uring_fsync::tests::probe`). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/uring_fsync.rs
git commit --no-verify -m "feat(strict): io_uring availability probe"
```

---

## Task 3: `UringFsync` executor — start + async fsync + run loop **[linux]**

The core. One ring + thread; `async fn fsync(Arc<File>)` submits an `IORING_OP_FSYNC` and awaits its CQE via a per-call `oneshot`.

**Files:**

- Modify: `src/uring_fsync.rs`
- Test: `src/uring_fsync.rs`

**Interfaces:**

- Produces:
  - `pub struct UringFsync` (the executor handle, cloneable via `Arc`).
  - `pub fn start() -> std::io::Result<std::sync::Arc<UringFsync>>` — create ring + eventfd, spawn the thread, return the handle.
  - `pub async fn fsync(&self, file: std::sync::Arc<std::fs::File>) -> std::io::Result<()>`.

- [ ] **Step 1: Implement the executor**

```rust
use std::collections::HashMap;
use std::os::fd::{AsRawFd, RawFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use io_uring::{opcode, types};
use tokio::sync::oneshot;

/// Reserved `user_data` for the eventfd wakeup Read SQE (real fsync ids start at 1).
const UD_EVENTFD: u64 = u64::MAX;
const RING_ENTRIES: u32 = 4096;

struct InFlight {
    tx: oneshot::Sender<std::io::Result<()>>,
    /// Keeps the file (and its fd) alive until the fsync CQE arrives.
    _file: Arc<std::fs::File>,
}

/// Shared state between the async callers and the dedicated ring thread.
struct Shared {
    /// Pending submissions: (user_data id, fd to fdatasync).
    queue: Mutex<std::collections::VecDeque<(u64, RawFd)>>,
    /// In-flight fsyncs awaiting their CQE, keyed by user_data id.
    inflight: Mutex<HashMap<u64, InFlight>>,
    /// True while the thread is awake and guaranteed to drain again before sleeping.
    armed: AtomicBool,
    /// Monotonic id source (starts at 1; never UD_EVENTFD).
    next_id: AtomicU64,
    eventfd: RawFd,
}

pub struct UringFsync {
    shared: Arc<Shared>,
}

impl UringFsync {
    /// Submit `file`'s fdatasync to the ring and await its completion.
    pub async fn fsync(&self, file: Arc<std::fs::File>) -> std::io::Result<()> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let fd = file.as_raw_fd();
        let (tx, rx) = oneshot::channel();
        // Register BEFORE enqueue/wake so the CQE handler always finds the entry.
        self.shared.inflight.lock().unwrap().insert(id, InFlight { tx, _file: file });
        self.shared.queue.lock().unwrap().push_back((id, fd));
        // Wake the thread unless it's already armed to drain (amortized wake).
        if !self.shared.armed.swap(false, Ordering::AcqRel) {
            let v: u64 = 1;
            // SAFETY: eventfd is a valid fd owned for the executor's lifetime; 8-byte counter write.
            unsafe { libc::write(self.shared.eventfd, &v as *const u64 as *const libc::c_void, 8); }
        }
        match rx.await {
            Ok(res) => res,
            // Sender dropped without sending ⇒ the ring thread died; fail the ack.
            Err(_) => Err(std::io::Error::other("strict io_uring fsync executor stopped")),
        }
    }
}

/// Create the ring + eventfd and spawn the dedicated submitter/reaper thread.
pub fn start() -> std::io::Result<Arc<UringFsync>> {
    let ring = IoUring::new(RING_ENTRIES)?;
    let eventfd: RawFd = unsafe { libc::eventfd(0, 0) };
    if eventfd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let shared = Arc::new(Shared {
        queue: Mutex::new(std::collections::VecDeque::new()),
        inflight: Mutex::new(HashMap::new()),
        armed: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
        eventfd,
    });
    let thread_shared = Arc::clone(&shared);
    std::thread::Builder::new()
        .name("strict-uring-fsync".to_string())
        .spawn(move || run_loop(thread_shared, ring, eventfd))?;
    Ok(Arc::new(UringFsync { shared }))
}

fn run_loop(shared: Arc<Shared>, mut ring: IoUring, eventfd: RawFd) {
    let mut eventfd_buf: u64 = 0;
    let mut eventfd_armed = false; // is a Read SQE for the eventfd currently in flight?

    // Helper: push an SQE, submitting first if the SQ is full. Returns Err on a
    // fatal submit error (treated as fatal: drain all in-flight with Err + exit).
    macro_rules! push_sqe {
        ($e:expr) => {{
            // SAFETY: entries reference fds/buffers kept alive (eventfd_buf is loop-scoped;
            // fsync targets via the inflight slab's Arc<File>).
            let pushed = unsafe { ring.submission().push(&$e).is_ok() };
            if !pushed {
                if ring.submit().is_err() { fatal(&shared); return; }
                if unsafe { ring.submission().push(&$e).is_err() } { fatal(&shared); return; }
            }
        }};
    }

    loop {
        // (1) Ensure the eventfd Read SQE is armed.
        if !eventfd_armed {
            let e = opcode::Read::new(types::Fd(eventfd), &mut eventfd_buf as *mut u64 as *mut u8, 8)
                .build()
                .user_data(UD_EVENTFD);
            push_sqe!(e);
            eventfd_armed = true;
        }

        // (2) Arm the wake-skip flag, then drain the queue (lost-wakeup-free: see WAL
        //     uring run_loop — set armed=true before draining; clear it before blocking).
        shared.armed.store(true, Ordering::Release);
        let mut batch: Vec<(u64, RawFd)> = Vec::new();
        {
            let mut q = shared.queue.lock().unwrap();
            while let Some(item) = q.pop_front() { batch.push(item); }
        }

        // (3) Submit an FSYNC/DATASYNC SQE per drained fsync.
        for (id, fd) in &batch {
            let e = opcode::Fsync::new(types::Fd(*fd))
                .flags(types::FsyncFlags::DATASYNC)
                .build()
                .user_data(*id);
            push_sqe!(e);
        }

        // (4) If we drained work this iteration, submit without blocking and loop to
        //     drain more (process-more-first). Only block when a drain came back empty.
        if !batch.is_empty() {
            if ring.submit().is_err() { fatal(&shared); return; }
            // reap whatever completed, then loop
            reap(&shared, &mut ring, &mut eventfd_armed);
            continue;
        }

        // (5) Empty drain: clear armed BEFORE the final re-check so a straggler enqueue
        //     writes the eventfd (lost-wakeup-free). Then block for >=1 completion.
        shared.armed.store(false, Ordering::Release);
        if !shared.queue.lock().unwrap().is_empty() {
            continue; // a straggler arrived; loop to drain it
        }
        if ring.submit_and_wait(1).is_err() { fatal(&shared); return; }
        reap(&shared, &mut ring, &mut eventfd_armed);
    }
}

/// Reap all ready CQEs: eventfd → re-arm; fsync id → send result on its oneshot.
fn reap(shared: &Arc<Shared>, ring: &mut IoUring, eventfd_armed: &mut bool) {
    let cqes: Vec<(u64, i32)> = ring.completion().map(|c| (c.user_data(), c.result())).collect();
    for (ud, res) in cqes {
        if ud == UD_EVENTFD {
            *eventfd_armed = false; // consumed; re-arm next iteration
            continue;
        }
        if let Some(entry) = shared.inflight.lock().unwrap().remove(&ud) {
            let result = if res < 0 {
                Err(std::io::Error::from_raw_os_error(-res))
            } else {
                Ok(())
            };
            let _ = entry.tx.send(result); // receiver may have dropped (cancelled leader)
            // entry (incl. Arc<File>) dropped here → fd released
        }
    }
}

/// Fatal ring error: fail every in-flight fsync so no `sync_to` leader hangs.
fn fatal(shared: &Arc<Shared>) {
    let mut map = shared.inflight.lock().unwrap();
    for (_, entry) in map.drain() {
        let _ = entry.tx.send(Err(std::io::Error::other("strict io_uring fsync executor failed")));
    }
    eprintln!("strict io_uring fsync executor: fatal ring error, thread exiting");
}
```

> **Implementer note:** verify the `io-uring` 0.7 API against `cargo doc -p io-uring` in the container if needed (same crate the WAL committer uses). The lost-wakeup protocol mirrors the reviewed-correct one in `src/wal/uring.rs` (`run_loop`): arm before drain, clear-armed + re-check queue before blocking. Do not deviate from that ordering.

- [ ] **Step 2: Write the durability test** (append to `uring_fsync.rs` tests)

```rust
    #[test]
    fn fsync_makes_writes_durable_and_returns_ok() {
        use std::io::Write;
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("ds-strict-uring-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.dat");
        let mut f = std::fs::OpenOptions::new().create(true).write(true).read(true).open(&path).unwrap();
        f.write_all(b"hello-strict-io-uring").unwrap();
        let file = Arc::new(f);

        let pool = start().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(pool.fsync(Arc::clone(&file))).expect("fsync ok");

        let raw = std::fs::read(&path).unwrap();
        assert_eq!(&raw, b"hello-strict-io-uring", "bytes present after fsync");
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 3: Run in Docker** (scope `uring_fsync`). Iterate on API/compile errors against `cargo doc -p io-uring`. Expected: probe + durability PASS.

- [ ] **Step 4: Commit**

```bash
git add src/uring_fsync.rs
git commit --no-verify -m "feat(strict): UringFsync executor (shared ring, async oneshot-bridged fdatasync)"
```

---

## Task 4: failure + concurrency tests **[linux]**

**Files:**

- Modify: `src/uring_fsync.rs` (tests + a tiny `#[cfg(test)]` helper if needed)

- [ ] **Step 1: Concurrency test — many distinct files, results not cross-wired**

```rust
    #[test]
    fn many_concurrent_fsyncs_all_resolve() {
        use std::io::Write;
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("ds-strict-uring-conc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pool = start().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let mut files = Vec::new();
        for i in 0..256u32 {
            let p = dir.join(format!("f{i}.dat"));
            let mut f = std::fs::OpenOptions::new().create(true).write(true).read(true).open(&p).unwrap();
            f.write_all(format!("rec-{i}").as_bytes()).unwrap();
            files.push(Arc::new(f));
        }
        rt.block_on(async {
            let futs: Vec<_> = files.iter().map(|f| pool.fsync(Arc::clone(f))).collect();
            for r in futures_join_all(futs).await { r.expect("each fsync ok"); }
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
```

> **Implementer note:** the crate has no `futures` dep. Either spawn each `pool.fsync` on the tokio runtime via `tokio::spawn` and await the `JoinHandle`s, or await sequentially in a loop (still exercises the slab/batch across many ids). Use whichever compiles with the existing deps (prefer `tokio::spawn` + join). Replace `futures_join_all` accordingly.

- [ ] **Step 2: Failure test — a bad fd yields Err to the awaiter**

```rust
    #[test]
    fn fsync_on_bad_fd_returns_err() {
        use std::sync::Arc;
        // An fd that is not valid for fsync: open /dev/null read-only and close a dup,
        // or use a pipe read end. Simplest deterministic: fsync a fd opened O_PATH is
        // EBADF-ish; but to drive the real CQE error, fsync a closed fd via a wrapper.
        // Implementer: construct an Arc<File> whose fd the kernel will reject for fsync
        // (e.g. a pipe read-end wrapped in File). Assert the awaited result is Err.
        let pool = start().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Pipe: the read end is a valid fd but fdatasync on a pipe returns EINVAL.
        let mut fds = [0 as libc::c_int; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let read_file = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fds[0]) };
        let _write_end = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fds[1]) };
        let res = rt.block_on(pool.fsync(Arc::new(read_file)));
        assert!(res.is_err(), "fdatasync on a pipe fd must surface an error to the awaiter");
    }
```

> **Implementer note:** confirm in the container that `fdatasync`/`IORING_OP_FSYNC` on a pipe fd returns a negative CQE (EINVAL). If a pipe does NOT error on your kernel, switch to a fd type that does (e.g. an `O_PATH` fd, or a socket). The REQUIREMENT is that a real negative fsync CQE propagates `Err` to the `fsync().await` caller — pick whatever fd reliably produces that. Do not assert via faking the result.

- [ ] **Step 3: Run in Docker** (scope `uring_fsync`). Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/uring_fsync.rs
git commit --no-verify -m "test(strict): UringFsync concurrency + fsync-error propagation"
```

---

## Task 5: global install + `sync_to` integration **[host]**

Wire the executor into the strict path: a process-global handle + the cfg'd branch in `SyncCoalescer::sync_to`.

**Files:**

- Modify: `src/uring_fsync.rs` (global + `install`/`handle`)
- Modify: `src/store.rs` (`sync_to` leader branch)

**Interfaces:**

- Consumes: `UringFsync` (Task 3).
- Produces (in `uring_fsync`):
  - `pub fn install(pool: std::sync::Arc<UringFsync>)` — set the process-global once.
  - `pub fn handle() -> Option<std::sync::Arc<UringFsync>>` — current global (None if unset).

- [ ] **Step 1: Add the global + accessors** (`uring_fsync.rs`)

```rust
use std::sync::OnceLock;

static STRICT_URING: OnceLock<Arc<UringFsync>> = OnceLock::new();

/// Install the process-global strict fsync executor (once, at startup).
pub fn install(pool: Arc<UringFsync>) {
    let _ = STRICT_URING.set(pool);
}

/// The installed executor, or `None` (spawn_blocking fallback).
pub fn handle() -> Option<Arc<UringFsync>> {
    STRICT_URING.get().cloned()
}
```

- [ ] **Step 2: Branch the `sync_to` leader fsync** (`store.rs`)

Find the leader fsync line (`store.rs`, in `SyncCoalescer::sync_to`):

```rust
                let res = tokio::task::spawn_blocking(move || barrier_fsync(&f)).await;
                guard.armed = false;
                crate::telemetry::record_fsync(t.elapsed_secs(), batch);
                let fsync_res: std::io::Result<()> = match res {
                    Ok(inner) => inner,
                    Err(e) => Err(std::io::Error::other(e)),
                };
```

Replace the first line (`let res = ...spawn_blocking...await;`) and the `fsync_res` mapping with a cfg'd selection. Keep `guard.armed = false;` and `record_fsync(...)` exactly where they are (after the await):

```rust
                #[cfg(all(target_os = "linux", feature = "strict-uring"))]
                let fsync_res: std::io::Result<()> = match crate::uring_fsync::handle() {
                    Some(pool) => pool.fsync(f).await,
                    None => match tokio::task::spawn_blocking(move || barrier_fsync(&f)).await {
                        Ok(inner) => inner,
                        Err(e) => Err(std::io::Error::other(e)),
                    },
                };
                #[cfg(not(all(target_os = "linux", feature = "strict-uring")))]
                let fsync_res: std::io::Result<()> =
                    match tokio::task::spawn_blocking(move || barrier_fsync(&f)).await {
                        Ok(inner) => inner,
                        Err(e) => Err(std::io::Error::other(e)),
                    };
                guard.armed = false;
                crate::telemetry::record_fsync(t.elapsed_secs(), batch);
```

(`f` is the cloned `Arc<File>` already created above as `let f = file.clone();`. The `pool.fsync(f)` arm moves `f`; the spawn_blocking arms also move `f` — they're in separate match arms / cfg branches so only one consumes it. Ensure `f` is `Arc<std::fs::File>` — it is.)

- [ ] **Step 3: Verify the default + feature builds compile and strict behavior is unchanged**

This is host-testable (the global is unset in unit tests, so `handle()` returns `None` → the existing spawn_blocking path runs — behavior unchanged). Run the existing store/strict tests:

```bash
cargo test store:: -- --nocapture
cargo build --features strict-uring
cargo clippy --all-targets
cargo clippy --all-targets --features strict-uring
```

Expected: all pass; clippy clean (no new warnings in either config). The default build must remain warning-clean.

- [ ] **Step 4: Commit**

```bash
git add src/uring_fsync.rs src/store.rs
git commit --no-verify -m "feat(strict): global executor + sync_to uses it (spawn_blocking fallback when unset)"
```

---

## Task 6: `--strict-io-uring` flag + startup install **[host build / linux smoke]**

**Files:**

- Modify: `src/main.rs`

**Interfaces:**

- Consumes: `crate::uring_fsync::{probe, start, install}` (gated).

- [ ] **Step 1: Add the flag variable + arg parse** (`main.rs`)

Near the `wal_io_uring` flag (main.rs ~80), add:

```rust
    // `--strict-io-uring` opts into the io_uring fsync executor for the strict
    // per-stream fdatasync (Linux + `strict-uring` feature only; otherwise falls
    // back to spawn_blocking with a warning). Only consulted under `--durability strict`.
    let mut strict_io_uring = false;
```

Next to the `"--wal-io-uring"` arm, add:

```rust
            "--strict-io-uring" => {
                strict_io_uring = true;
            }
```

- [ ] **Step 2: Startup probe + install** (`main.rs`)

After durability mode is set and before the server starts serving (place it near the WAL committer setup; it must run regardless of WAL, but only matters for strict). Add:

```rust
    if strict_io_uring {
        #[cfg(all(target_os = "linux", feature = "strict-uring"))]
        {
            if handlers::durability() == handlers::DurabilityMode::Strict && uring_fsync::probe() {
                match uring_fsync::start() {
                    Ok(pool) => {
                        uring_fsync::install(pool);
                        eprintln!("strict: io_uring fsync executor active");
                    }
                    Err(e) => eprintln!("strict: io_uring fsync executor failed to start ({e}) — using spawn_blocking"),
                }
            } else if handlers::durability() != handlers::DurabilityMode::Strict {
                eprintln!("strict: --strict-io-uring ignored (only applies to --durability strict)");
            } else {
                eprintln!("strict: io_uring unavailable (probe failed) — using spawn_blocking");
            }
        }
        #[cfg(not(all(target_os = "linux", feature = "strict-uring")))]
        {
            eprintln!("strict: --strict-io-uring requested but this build has no io_uring support — using spawn_blocking");
        }
    }
```

- [ ] **Step 3: Build both configs + clippy**

```bash
cargo build
cargo build --features strict-uring
cargo clippy --all-targets --features strict-uring
```

Expected: all succeed, clippy clean.

- [ ] **Step 4: Linux smoke (Docker)** — server starts with the flag, logs executor active, serves a strict append

```bash
docker run --rm --privileged -v "$PWD":/src -w /src \
  -v ds-cargo-registry:/usr/local/cargo/registry -v ds-target:/tmp/target \
  -e CARGO_TARGET_DIR=/tmp/target rust:latest bash -c '
    cargo build --release --features strict-uring --target-dir /tmp/target &&
    /tmp/target/release/durable-streams-server --durability strict --strict-io-uring \
      --data-dir /tmp/ds --port 8790 --host 0.0.0.0 & sleep 2 &&
    curl -sS -X PUT localhost:8790/s1 -d "" -o /dev/null -w "PUT %{http_code}\n" &&
    curl -sS -X POST localhost:8790/s1 -H "content-type: application/octet-stream" --data-binary "hi" -w " POST %{http_code}\n" '
```

Expected: server logs `strict: io_uring fsync executor active`; `PUT 2xx`, `POST 2xx`.

- [ ] **Step 5: Commit**

```bash
git add src/main.rs
git commit --no-verify -m "feat(strict): --strict-io-uring flag installs the io_uring fsync executor (probe + fallback)"
```

---

## Task 7: conformance + docs **[linux + host]**

**Files:**

- Modify: `README.md`, `docs/durable-wal.md` (or strict section), `docs/superpowers/durability-performance-followups.md`

- [ ] **Step 1: Conformance (Docker)**

Start the server in Docker (release, `--durability strict --strict-io-uring`, `--long-poll-timeout-ms 500`, `--host 0.0.0.0 --port 8790`, port-mapped), then from the main checkout's installed deps:

```bash
cd /Users/vbalegas/workspace/durable-streams && RUST_SERVER_URL=http://localhost:8790 \
  pnpm exec vitest run --config packages/server-rust/conformance/vitest.config.ts
```

Expected: matches the strict baseline (326/332, 6 subscription skips, 0 failures). Confirm the server log shows `strict: io_uring fsync executor active`. If any non-skip test fails, report it as a gap (fix in the relevant task).

- [ ] **Step 2: Docs**

- `README.md`: add `--strict-io-uring` to the durability flags (Linux + `strict-uring` feature, off by default, CPU-per-append lever for the strict path, falls back to spawn_blocking).
- `docs/durable-wal.md` (or a strict-durability section): add a short subsection on the io_uring fsync executor (single shared ring/thread, batches per-stream `fdatasync`s, gating/probe/fallback, unchanged data/recovery/durability). **No fabricated numbers** — measured CPU delta pending the bench run.
- `docs/superpowers/durability-performance-followups.md`: mark follow-up **#2 (io_uring for strict)** IMPLEMENTED (reference the spec + `--strict-io-uring`), noting it shipped as a shared `UringFsync` executor (not per-stream).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/durable-wal.md docs/superpowers/durability-performance-followups.md
git commit --no-verify -m "docs(strict): document --strict-io-uring fsync executor"
```

> **Benchmark (deferred to bench hardware):** add a `durable:strict-iouring` variant to the `ds-rust-bench` `gke-bench.sh` (analogous to `durable:wal-iouring`: `--durability strict --strict-io-uring`) and A/B strict vs strict+io_uring at 10K streams (CPU/append + throughput). Not part of this plan's commits — run alongside the WAL comparison.

---

## Self-Review (completed during planning)

- **Spec coverage:** §3 executor → Tasks 2–4; §4 integration (global + sync_to) → Task 5; §5 gating/flag/probe/fallback → Tasks 1, 2, 6; §6 failure semantics (oneshot Err, fatal drain, cancellation) → Tasks 3 (fatal/cancellation in run_loop/reap) + 4 (error test); §7 testing/conformance/bench → Tasks 3, 4, 7; §8/§9 decisions/out-of-scope → reflected (single ring; bench/docs in 7).
- **Placeholder scan:** all code steps contain full code. The two test-injection points (concurrency join, bad-fd error) carry explicit implementer notes with a concrete requirement and a fallback, not silent TODOs.
- **Type consistency:** `probe() -> bool`, `start() -> io::Result<Arc<UringFsync>>`, `UringFsync::fsync(&self, Arc<File>) -> io::Result<()>`, `install(Arc<UringFsync>)`, `handle() -> Option<Arc<UringFsync>>`, the `STRICT_URING: OnceLock<Arc<UringFsync>>` global, and the `crate::uring_fsync::handle()` call in `store.rs` are consistent across tasks. `f: Arc<std::fs::File>` matches `fsync`'s parameter.

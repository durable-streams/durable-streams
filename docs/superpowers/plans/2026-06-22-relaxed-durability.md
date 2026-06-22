# Relaxed Durability Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `--durability relaxed` mode that acks an append/close without the hot-path data `fdatasync`, keeping `strict` (today's per-stream group-commit fsync) as the unchanged default.

**Architecture:** A module-global durability flag (mirroring the existing `set_splice_appends` / `READ_OFFLOAD` startup flags in `engine_raw.rs`) gates a single `maybe_sync_on_ack` helper that **all three** append `sync_to` call sites route through. Segment retention (`tier.rs` seal/offload/compact) and recovery are reused **unchanged** — recovery already derives the tail from the data-file size, so dropping the append fsync needs no recovery changes.

**Tech Stack:** Rust, tokio, crate `packages/server-rust` (binary `durable-streams-server`). Tests are inline `#[cfg(test)]` `#[tokio::test]` modules (no `tests/` dir).

## Global Constraints

- `strict` (default) MUST be byte-for-byte today's behavior. The only strict-path change is routing `sync_to` through a helper that, when not relaxed, calls it identically.
- **All THREE** append `sync_to` sites must be gated, via one shared helper (DRY): `handlers.rs:500` (PUT create-with-body), `handlers.rs:908` (mainline append + close), `handlers.rs:1215` (binary **splice** fast path). Missing the splice site silently keeps fsync there.
- Realize spec §4's "`DurabilityMode`" as a **module-global flag matching the established `set_splice_appends` pattern** (not a `Store` field): server-wide, set once at startup, read via a `Relaxed` atomic load on the hot path (zero strict-cost, no `store` plumbing into the create site). _This is an intentional, pattern-following refinement of spec §4 — same semantics._
- Only the append/close **data** `fdatasync` is dropped. Off-path seal/offload/manifest/close-meta commits keep their integrity (untouched).
- `--durability` default is `strict`; unknown value → `exit(2)` (matches the existing arg-parse style).
- Spec: `docs/superpowers/specs/2026-06-22-relaxed-durability-design.md`.

---

### Task 1: `--durability` flag + durability-mode global

**Files:**

- Modify: `packages/server-rust/src/handlers.rs` (add the global + setter/getter near the other module-level config such as `set_long_poll_timeout`)
- Modify: `packages/server-rust/src/main.rs` (arg `match` loop — add a `--durability` arm immediately before the `other =>` catch-all, ~L127)
- Test: `packages/server-rust/src/handlers.rs` (inline `#[cfg(test)]` module)

**Interfaces:**

- Produces: `handlers::set_durability_relaxed(relaxed: bool)` and `handlers::durability_relaxed() -> bool` (default `false` = strict). Task 2 consumes `durability_relaxed()`.

- [ ] **Step 1: Write the failing test** (append to an existing `#[cfg(test)] mod` in `handlers.rs`, or add one; reuse `use super::*;`)

```rust
#[test]
fn durability_flag_defaults_strict_and_flips() {
    // Process-global flag. This is the ONLY test that mutates it; it resets at the
    // end so no append-path test (which reads it) is perturbed.
    assert!(!durability_relaxed(), "default must be strict");
    set_durability_relaxed(true);
    assert!(durability_relaxed(), "set_durability_relaxed(true) takes effect");
    set_durability_relaxed(false); // reset
    assert!(!durability_relaxed());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p durable-streams-server durability_flag_defaults_strict_and_flips`
Expected: FAIL — compile error, `cannot find function durability_relaxed`.

- [ ] **Step 3: Implement the global** (in `handlers.rs`, top-level, near the other module-level config; mirror `engine_raw.rs`'s `SPLICE_APPENDS`)

```rust
/// Durability mode for the append/close hot path. Default strict (`false`): ack only
/// after the covering `fdatasync` (`SyncCoalescer::sync_to`). Relaxed (`true`): ack on
/// the page-cache write, skipping the hot-path `fdatasync` — durability then comes from
/// S3-offload (cold) + future replication (hot tail). Set once at startup from
/// `--durability`; mirrors the `set_splice_appends` / `set_read_offload` flag pattern.
static DURABILITY_RELAXED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn set_durability_relaxed(relaxed: bool) {
    DURABILITY_RELAXED.store(relaxed, std::sync::atomic::Ordering::Relaxed);
}

pub fn durability_relaxed() -> bool {
    DURABILITY_RELAXED.load(std::sync::atomic::Ordering::Relaxed)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p durable-streams-server durability_flag_defaults_strict_and_flips`
Expected: PASS.

- [ ] **Step 5: Wire the CLI flag** (in `main.rs`, add this arm immediately before `other =>` in the arg `match`)

```rust
"--durability" => {
    let v = val(args.next(), "--durability");
    match v.as_str() {
        "strict" => handlers::set_durability_relaxed(false),
        "relaxed" => handlers::set_durability_relaxed(true),
        _ => {
            eprintln!("--durability must be strict|relaxed");
            std::process::exit(2);
        }
    }
}
```

- [ ] **Step 6: Build to confirm `main.rs` compiles**

Run: `cargo build -p durable-streams-server`
Expected: success (no errors).

- [ ] **Step 7: Commit**

```bash
git add packages/server-rust/src/handlers.rs packages/server-rust/src/main.rs
git commit -m "feat(durability): --durability strict|relaxed flag + global (default strict)"
```

---

### Task 2: `maybe_sync_on_ack` helper + gate all three `sync_to` sites

**Files:**

- Modify: `packages/server-rust/src/handlers.rs` (add the helper; replace the 3 `sync_to` calls at ~L500, ~L908, ~L1215)
- Modify: `packages/server-rust/src/store.rs` (add a test-only watermark accessor to `SyncCoalescer`)
- Test: `packages/server-rust/src/handlers.rs` (inline)

**Interfaces:**

- Consumes: `durability_relaxed()` (Task 1); `SyncCoalescer::sync_to(&self, Arc<std::fs::File>, &StreamState, u64) -> std::io::Result<()>`.
- Produces: `async fn maybe_sync_on_ack(relaxed: bool, st: &StreamState, file: Arc<std::fs::File>, target: u64) -> std::io::Result<()>` — all three sites call it as `maybe_sync_on_ack(durability_relaxed(), &st, file, target)`.

- [ ] **Step 1: Add the test-only watermark accessor** (in `store.rs`, inside `impl SyncCoalescer`)

```rust
/// Test-only: the current durable watermark (bytes proven synced). Lets a test
/// assert that `strict` advanced it and `relaxed` did not (fsync was skipped).
#[cfg(test)]
pub fn synced(&self) -> u64 {
    self.inner.lock().unwrap().synced
}
```

- [ ] **Step 2: Write the failing test** (in the `handlers.rs` `#[cfg(test)]` module)

```rust
#[tokio::test]
async fn maybe_sync_on_ack_strict_syncs_relaxed_skips() {
    use crate::store::{CreateResult, Store, StreamConfig};
    use crate::tier::TierConfig;

    let dir = std::env::temp_dir().join(format!(
        "ds-durab-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = std::sync::Arc::new(Store::new_with_tier(dir.clone(), TierConfig::default()).unwrap());
    let cfg = StreamConfig {
        content_type: "application/octet-stream".into(),
        ttl_seconds: None,
        expires_at: None,
        expires_at_raw: None,
        create_closed: false,
        forked_from: None,
        fork_offset_raw: None,
        fork_sub_offset: None,
    };
    let st = match store.create("s", cfg, None, 0).unwrap() {
        CreateResult::Created(s) => s,
        _ => panic!("create failed"),
    };

    // Write 10 bytes via the same path the handler uses, then STRICT-sync.
    let mut ap = st.appender.lock().await;
    write_wire(&st, &mut ap, &bytes::Bytes::from_static(b"0123456789")).unwrap();
    let target = ap.written;
    let file = ap.file.clone();
    drop(ap);
    maybe_sync_on_ack(false, &st, file, target).await.unwrap();
    assert_eq!(st.sync.synced(), target, "strict must advance the durable watermark");

    // Append 5 more; RELAXED must skip the fsync → watermark unchanged.
    let mut ap = st.appender.lock().await;
    write_wire(&st, &mut ap, &bytes::Bytes::from_static(b"abcde")).unwrap();
    let target2 = ap.written;
    let file2 = ap.file.clone();
    drop(ap);
    maybe_sync_on_ack(true, &st, file2, target2).await.unwrap();
    assert_eq!(st.sync.synced(), target, "relaxed must skip fsync (watermark unchanged)");
    assert!(target2 > target, "the bytes were still written (tail advanced)");

    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p durable-streams-server maybe_sync_on_ack_strict_syncs_relaxed_skips`
Expected: FAIL — `cannot find function maybe_sync_on_ack`.

- [ ] **Step 4: Implement the helper** (in `handlers.rs`, near the append handlers)

```rust
/// Gate the covering data `fdatasync` on the durability mode. `strict`
/// (`relaxed == false`) awaits `sync_to` exactly as before; `relaxed` returns `Ok`
/// without syncing — the ack happens on the page-cache write. Every append/close
/// `sync_to` site routes through this one helper so all three are gated together.
async fn maybe_sync_on_ack(
    relaxed: bool,
    st: &StreamState,
    file: std::sync::Arc<std::fs::File>,
    target: u64,
) -> std::io::Result<()> {
    if relaxed {
        return Ok(());
    }
    st.sync.sync_to(file, st, target).await
}
```

- [ ] **Step 5: Replace the three call sites** (exact edits; `&st` is `&Arc<StreamState>` and derefs to the `&StreamState` param)

`handlers.rs:~500` (create-with-body):

```rust
// before
if st.sync.sync_to(file, &st, target).await.is_err() {
// after
if maybe_sync_on_ack(durability_relaxed(), &st, file, target).await.is_err() {
```

`handlers.rs:~908` (append + close):

```rust
// before
if !wire.is_empty() && st.sync.sync_to(file, &st, target).await.is_err() {
// after
if !wire.is_empty() && maybe_sync_on_ack(durability_relaxed(), &st, file, target).await.is_err() {
```

`handlers.rs:~1215` (binary splice fast path):

```rust
// before
if st.sync.sync_to(file, &st, target).await.is_err() {
// after
if maybe_sync_on_ack(durability_relaxed(), &st, file, target).await.is_err() {
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cargo test -p durable-streams-server maybe_sync_on_ack_strict_syncs_relaxed_skips`
Expected: PASS.

- [ ] **Step 7: Run the full suite to confirm the strict path is unregressed**

Run: `cargo test -p durable-streams-server`
Expected: all tests pass (the strict path calls `sync_to` identically; the only new behavior is the relaxed branch).

- [ ] **Step 8: Commit**

```bash
git add packages/server-rust/src/handlers.rs packages/server-rust/src/store.rs
git commit -m "feat(durability): gate all three sync_to sites via maybe_sync_on_ack (relaxed skips fsync)"
```

---

## Final validation (after both tasks)

- [ ] `cargo test -p durable-streams-server` — full suite green (strict unregressed; relaxed gate covered).
- [ ] `cargo clippy -p durable-streams-server --all-targets` — warning-clean (esp. no unused `file`/`target` warnings; both are referenced inside `maybe_sync_on_ack`).
- [ ] **Benchmark (ds-rust-bench, separate, GKE, post-merge):** `--durability relaxed` vs `strict` on the cardinality sweep + single-stream append. Success = `relaxed` ≈ the measured `ref-nofsync` (≈2.4× at N=10, ≈1.13× at N=10,000). This validates spec SC1; it is not a `cargo test`.

## Spec coverage notes

- **SC1** (relaxed acks without hot-path fdatasync; matches `ref-nofsync`): Task 2 gate + the GKE bench above.
- **SC2** (strict default byte-for-byte): Task 2 helper calls `sync_to` identically when not relaxed; Step 7 full-suite regression.
- **SC3** (sealed data durable under relaxed; recovery yields a consistent prefix): the seal/offload/recovery path is **unchanged** by this work (it never depended on the append fsync) and is already covered by the existing `tier.rs` / recovery tests. The relaxed-specific _partial-tail loss_ on an OS/power crash cannot be reproduced in a unit test (an in-process write reaches the file regardless of fsync) — it is covered conceptually by the design (§6) and operationally by the bench/soak, not a unit test. No redundant test added (YAGNI).
- **SC4** (recovery O(1), no new scan): recovery code is untouched (`recover_one_inner` already derives the tail from `file.metadata().len()`); nothing to implement.

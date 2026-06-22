# Durable WAL (`--durability wal`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (opus per the user's directive). Steps use checkbox (`- [ ]`) syntax. **The spec is the detailed design reference — read the cited § for each task:** `docs/superpowers/specs/2026-06-22-durable-wal-v2-design.md`. Follow-ups (do NOT build): `docs/superpowers/durability-performance-followups.md`.

**Goal:** Add `--durability wal` — a sharded (per-CPU), segmented write-ahead log giving single-node no-loss durability + clean recovery (no torn records), with reads unchanged and no v1-style collapse.

**Architecture:** Per-stream files remain the only read surface (written on the hot path, page cache, no per-append fsync). A sharded WAL (`N` = persisted core count; `shard = hash(stream_id)%N`) holds the durable record; `N` per-CPU committers group-commit + `fdatasync` in parallel; per-shard checkpoint fsyncs the per-stream files then recycles WAL segments; per-shard recovery replays the framed WAL to repair the file tail to the durable frontier. A `DurabilityMode` enum (`Strict|Wal|Fast`) behind the existing `maybe_sync_on_ack` choke-point selects the path.

**Tech Stack:** Rust, tokio, crate `packages/server-rust` (binary `durable-streams-server`). Inline `#[cfg(test)]` `#[tokio::test]` tests. `libc` (`fallocate`/`fdatasync`) is already a dep (`store.rs`). **`crc32c` is NOT yet a dep — Task 1 adds `crc32c = "0.6"` to `packages/server-rust/Cargo.toml`** (the only new dependency; note it in the Task 1 commit). For the shard count use `std::thread::available_parallelism()` (already used at `main.rs:156`), NOT `num_cpus` (not a dep).

## Global Constraints

- `strict` (default) and `fast` MUST be byte-for-byte the existing per-stream-file paths; `relaxed`→`fast` is a clean rename (no deployed consumer). The WAL module is **inert** unless `--durability wal`.
- `wal` ack ⇒ the record is in the shard's `fdatasync`'d WAL (no-loss). Ack gates on `durable_lsn ≥ lsn`; `durable_lsn` advances only to the **highest contiguous fully-written** lsn (§6), never the highest assigned.
- **All record kinds for a stream route by `hash(stream_id)%N`** (same shard). `N` is persisted at init (`<data-dir>/wal/shards`); the shard is computed only from persisted `N` + `stream_id`, never per-boot `available_parallelism`; `--wal-shards ≠ persisted N` ⇒ exit 2 (§5).
- B-light framing: header-CRC only, **no payload CRC** (preserves future splice); torn-tail = header_crc-valid AND `len` payload bytes present (§4).
- Reads are NEVER served from the WAL. `--splice-appends` is a no-op under `wal` (v1): payload buffered + `write()`-en to both per-stream file and WAL (§3).
- Checkpoint fsyncs per-stream files BEFORE recycling WAL segments below `checkpoint_lsn` (§7). Recovery maps `file_pos = stream_offset − file_base` and SKIPS records with `stream_offset < file_base` (§9). WAL replay never allocates `stream_id` (identity is the existing sidecar pass, §9).

## File Structure

- `src/wal/mod.rs` — public surface: `WalSet`, `DurabilityMode`, `set_durability`/`durability`, `wal_append`.
- `src/wal/codec.rs` — record framing (encode/decode/crc/torn-tail).
- `src/wal/segment.rs` — `SegmentWriter` (fallocate + header write + payload write + fdatasync) + segment files.
- `src/wal/shard.rs` — one shard: append buffer, committer loop, `durable_lsn`, contiguous-written watermark, checkpoint, recycle.
- `src/wal/recovery.rs` — per-shard replay + file-tail repair.
- `src/wal/telemetry.rs` — per-shard batch histogram + 1 Hz emitter.
- Modify `src/store.rs` (Store gains `wal: Option<Arc<wal::WalSet>>`; the wal append helper), `src/handlers.rs` (generalize `maybe_sync_on_ack` → mode dispatch), `src/main.rs` (flags + rename + build/spawn).

Keep each `wal/*.rs` focused; `mod.rs` re-exports.

---

### Task 1: Record codec + B-light framing (`src/wal/codec.rs`)

**Files:** Create `src/wal/codec.rs`, `src/wal/mod.rs` (with `pub mod codec;`); Modify `src/main.rs` (add `mod wal;`). Test: inline in `codec.rs`.

**Interfaces — Produces:**

- `pub struct Record<'a> { pub lsn: u64, pub kind: RecordKind, pub stream_id: u64, pub stream_offset: u64, pub payload: &'a [u8] }`
- `pub enum RecordKind { Append=1, StreamCreate=2, StreamClose=3, StreamDelete=4 }` (`from_u8`/`as u8`)
- `pub const HEADER_LEN: usize = 33;` (`u32 len + u32 crc + u64 lsn + u8 kind + u64 stream_id + u64 stream_offset`)
- `pub fn encode_into(buf: &mut Vec<u8>, r: &Record)` — appends header+payload; crc32c over `[lsn,kind,stream_id,stream_offset,len]`.
- `pub enum Decoded { Record { lsn:u64, kind:RecordKind, stream_id:u64, stream_offset:u64, payload_off:usize, len:usize, total:usize }, Incomplete, Torn }`
- `pub fn decode_at(seg: &[u8], off: usize) -> Decoded` — `Torn` if header present but crc bad or `len` payload bytes absent; `Incomplete` if < `HEADER_LEN` (or all-zero header from fallocate).

- [ ] **Step 1: failing test** — round-trip + torn detection:

```rust
#[test]
fn encode_decode_roundtrip_and_torn() {
    let mut b = Vec::new();
    let r = Record { lsn: 7, kind: RecordKind::Append, stream_id: 3, stream_offset: 100, payload: b"hello" };
    encode_into(&mut b, &r);
    match decode_at(&b, 0) {
        Decoded::Record { lsn, kind, stream_id, stream_offset, payload_off, len, total } => {
            assert_eq!((lsn, stream_id, stream_offset, len), (7, 3, 100, 5));
            assert!(matches!(kind, RecordKind::Append));
            assert_eq!(&b[payload_off..payload_off+len], b"hello");
            assert_eq!(total, HEADER_LEN + 5);
        }
        _ => panic!("expected Record"),
    }
    // torn payload: drop last byte → header says len=5 but only 4 present
    let torn = &b[..b.len()-1];
    assert!(matches!(decode_at(torn, 0), Decoded::Torn));
    // torn header (partial) and all-zero (fallocate) → not a Record
    assert!(matches!(decode_at(&b[..HEADER_LEN-1], 0), Decoded::Incomplete | Decoded::Torn));
    assert!(matches!(decode_at(&vec![0u8; HEADER_LEN+5], 0), Decoded::Incomplete | Decoded::Torn));
}
```

- [ ] **Step 2:** `cargo test -p durable-streams-server -- codec::` → FAIL (module absent).
- [ ] **Step 3:** First **add `crc32c = "0.6"` to `packages/server-rust/Cargo.toml`** (new dep — not yet present). Implement `codec.rs` per spec §4 (little-endian header; `crc32c::crc32c(&hdr_fields)`; `decode_at` validates header_crc then checks `seg.len() >= off+HEADER_LEN+len`). Add `mod wal;` to `main.rs` and `pub mod codec;` to `wal/mod.rs`.
- [ ] **Step 4:** test PASS.
- [ ] **Step 5:** `git commit -m "feat(wal): B-light record codec + torn-tail detection"`

---

### Task 2: `SegmentWriter` + segment files (`src/wal/segment.rs`)

**Files:** Create `src/wal/segment.rs` (`pub mod segment;` in mod.rs). Test: inline.

**Interfaces — Consumes:** codec. **Produces:**

- `pub const SEGMENT_BYTES: u64 = 128 * 1024 * 1024;`
- `pub trait SegmentWriter: Send + Sync { fn write_at(&self, off: u64, bytes: &[u8]) -> io::Result<()>; fn fdatasync(&self) -> io::Result<()>; }` — the io_uring drop-in seam (committer fsync goes through this).
- `pub struct FileSegment { path: PathBuf, file: std::fs::File }` impl `SegmentWriter` (positioned `pwrite`; `libc::fdatasync`). `FileSegment::create(path, SEGMENT_BYTES)` `fallocate`s to full size (§4).
- `pub fn seg_path(shard_dir: &Path, start_lsn: u64) -> PathBuf` → `<shard_dir>/<start_lsn>.wal`.

- [ ] **Step 1: failing test** — fallocate + positioned write + readback survives fsync:

```rust
#[tokio::test]
async fn segment_write_at_and_fdatasync() {
    let dir = tmp("seg"); std::fs::create_dir_all(&dir).unwrap();
    let s = FileSegment::create(seg_path(&dir, 0), 1<<20).unwrap();
    s.write_at(0, b"abc").unwrap();
    s.write_at(64, b"xyz").unwrap();   // disjoint offsets (concurrent-appender model)
    s.fdatasync().unwrap();
    let raw = std::fs::read(seg_path(&dir, 0)).unwrap();
    assert_eq!(raw.len() as u64, 1<<20, "fallocate'd to full size");
    assert_eq!(&raw[0..3], b"abc"); assert_eq!(&raw[64..67], b"xyz");
}
```

- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** Implement: `create` opens `O_RDWR|O_CREAT`, `libc::fallocate(fd,0,0,size)` (Linux; on macOS `ftruncate` fallback — match `store.rs` cfg pattern). `write_at` = `libc::pwrite`. `fdatasync` = `libc::fdatasync` (mirror `store.rs::barrier_fsync` cfg). `tmp` helper like `store.rs` tests.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(wal): fallocate'd SegmentWriter (positioned write + fdatasync)"`

---

### Task 3: Single shard — append, committer, durable_lsn, contiguous watermark (`src/wal/shard.rs`)

**Files:** Create `src/wal/shard.rs`. Test: inline.

**Interfaces — Consumes:** codec, segment. **Produces:**

- `pub struct Shard { /* inner: Mutex<ShardInner>, durable_tx: watch::Sender<u64>, notify: Notify, dir: PathBuf, stats: Arc<ShardStats> */ }`
- `pub fn Shard::open(dir: PathBuf) -> io::Result<Arc<Shard>>` (creates/opens active segment).
- `pub fn Shard::reserve_and_stage(&self, kind, stream_id, stream_offset, payload: &[u8]) -> u64` — under a short lock: assign `lsn`, reserve segment range, write header+payload off-lock via SegmentWriter (here: encode into a scratch buf then `write_at`), mark written; returns `lsn`. (Off-lock write detail per §5/§6; for v1 the encode+write_at happens after releasing the assign lock, then the appender bumps the contiguous-written watermark.)
- `pub async fn Shard::wait_durable(&self, lsn: u64)` — awaits `durable_lsn ≥ lsn`.
- `pub async fn Shard::run_committer(self: Arc<Self>)` — `notify.notified().await` → `fdatasync` active segment → advance `durable_lsn` to the **highest contiguous fully-written lsn** → `durable_tx.send`. fsync error ⇒ do not advance.
- `#[cfg(test)] pub fn durable_lsn(&self) -> u64`
- `#[cfg(test)] pub fn reserve_only(&self) -> u64` — assigns the next lsn + reserves the segment range but writes NO bytes (leaves a gap), so the watermark/gap test can prove the committer won't advance past an unwritten lsn.

- [ ] **Step 1: failing test** — append N then commit advances durable_lsn to the contiguous watermark; out-of-order completion does not over-advance:

```rust
#[tokio::test]
async fn committer_does_not_advance_past_unwritten_gap() {
    // l1 staged (written), l2 RESERVED-BUT-UNWRITTEN (gap), l3 staged (written).
    // The committer must NOT advance durable_lsn past the gap, even though l3's bytes
    // are on disk — durable_lsn may reach l1 but MUST stay < l3 until l2 is written.
    let sh = Shard::open(tmp("shard")).unwrap();
    let l1 = sh.reserve_and_stage(RecordKind::Append, 1, 0, b"a");
    let _l2 = sh.reserve_only();                  // #[cfg(test)] hook: assigns lsn, no write
    let l3 = sh.reserve_and_stage(RecordKind::Append, 1, 2, b"c");
    let h = tokio::spawn({ let s = sh.clone(); async move { s.run_committer().await }});
    sh.wait_durable(l1).await;
    // give the committer a beat to (incorrectly) over-advance if the watermark is broken
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(sh.durable_lsn() >= l1, "l1 (and its contiguous prefix) is durable");
    assert!(sh.durable_lsn() < l3, "MUST NOT advance past the unwritten l2 gap to l3");
    h.abort();
    // Then write l2 → next commit advances durable_lsn ≥ l3 (the full prefix is now written).
}
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement per §6: `ShardInner { active: FileSegment, seg_start_lsn, write_pos, next_lsn, written_set or a contiguous-written cursor }`. The contiguous-written watermark = highest lsn s.t. all ≤ it are written (track a min-heap / a `wrote[]` bitmap or a `BTreeSet` of completed-out-of-order lsns collapsed into a cursor). Committer: snapshot the watermark, fdatasync, set `durable_lsn = watermark`, send. Notify on every stage.
- [ ] **Step 4:** PASS (both tests).
- [ ] **Step 5:** `git commit -m "feat(wal): single-shard group-commit committer + contiguous-written watermark"`

---

### Task 4: Shard set — persisted N, hash routing, `--wal-shards` guard (`src/wal/shard.rs` + `mod.rs`)

**Files:** Modify `src/wal/shard.rs`/`mod.rs`. Test: inline.

**Interfaces — Produces:**

- `pub struct WalSet { shards: Vec<Arc<Shard>>, n: usize }`
- `pub fn WalSet::open(data_dir: &Path, requested_n: Option<usize>, default_n: usize) -> io::Result<Arc<WalSet>>` — read/create `<data_dir>/wal/shards` (persisted N). If the file exists and `requested_n` is `Some(x)` with `x ≠ persisted` → `Err` (caller exits 2). Else persist `requested_n.unwrap_or(default_n)` and open `N` shards under `wal/<i>/`. `default_n` is `available_parallelism()` passed by the caller (Task 8) — NOT `num_cpus` (not a dep).
- `pub fn WalSet::shard_for(&self, stream_id: u64) -> &Arc<Shard>` — `&self.shards[(fnv1a(stream_id) % self.n as u64) as usize]`.
- `pub fn WalSet::spawn_committers(self: &Arc<Self>)` — spawn `run_committer` per shard.

- [ ] **Step 1: failing test** — N persisted + stable across reopen, mismatch rejected, hash stable:

```rust
#[tokio::test]
async fn wal_shards_persisted_and_stable() {
    let d = tmp("wset");
    let w = WalSet::open(&d, Some(4), 16).unwrap();   // requested 4 → persisted 4 (default_n ignored)
    let s_id = 12345u64;
    let idx = w.shards.iter().position(|s| std::ptr::eq(&**s, &**w.shard_for(s_id))).unwrap();
    drop(w);
    // None + a DIFFERENT default_n (8) → still uses the persisted N (4), NOT default_n:
    let w2 = WalSet::open(&d, None, 8).unwrap();
    assert_eq!(w2.n, 4);
    let idx2 = w2.shards.iter().position(|s| std::ptr::eq(&**s, &**w2.shard_for(s_id))).unwrap();
    assert_eq!(idx, idx2, "stream resolves to the same shard across reopen");
    assert!(WalSet::open(&d, Some(8), 8).is_err(), "mismatched --wal-shards rejected");
}
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement (fnv1a or the crate's existing hasher; persist N as text in `wal/shards`). **Step 4:** PASS. **Step 5:** `git commit -m "feat(wal): sharded WalSet — persisted N + stable hash routing + mismatch guard"`

---

### Task 5: `DurabilityMode` + append-path integration (`store.rs`, `handlers.rs`)

**Files:** Modify `src/handlers.rs` (generalize the `durability_relaxed` bool → `DurabilityMode`; the 3 `maybe_sync_on_ack` sites), `src/store.rs` (`Store.wal` field + `wal_append` helper). Test: inline in `handlers.rs`.

**Interfaces — Consumes:** WalSet. **Produces:**

- `pub enum DurabilityMode { Strict, Wal, Fast }` + `set_durability(DurabilityMode)` / `durability() -> DurabilityMode` (replaces `set_durability_relaxed`/`durability_relaxed`; `Strict`=default).
- In `wal` mode the append: `write_wire` to the per-stream file (page cache) as today (the read view), THEN `store.wal.shard_for(stream_id).reserve_and_stage(Append, id, offset, &wire)` and `wait_durable(lsn)` before ack. `strict`/`fast` keep `maybe_sync_on_ack` (renamed enum, identical behavior).

- [ ] **Step 1: failing test** — `wal` mode acks only after the shard's durable_lsn covers the append; `strict`/`fast` unchanged:

```rust
#[tokio::test]
async fn wal_mode_acks_after_durable() {
    // build a Store with a WalSet (1 shard), create stream, drive the wal append helper,
    // assert: bytes are in the per-stream file immediately; ack returns only after the
    // committer advances durable_lsn ≥ the append's lsn.
}
```

- [ ] **Step 2:** FAIL. **Step 3:** Generalize the choke-point. The current helper is `maybe_sync_on_ack(relaxed: bool, st, file, target)` at `handlers.rs:586` called from 3 sites (`:516`, `:950`, `:1260`). **Change its signature to `maybe_sync_on_ack(mode: DurabilityMode, store: &Arc<Store>, st: &StreamState, wire: &Bytes, file: Arc<File>, target: u64)`** (`store` and `wire` are in scope at all 3 sites). Body: `match mode { Strict => st.sync.sync_to(file, st, target).await, Fast => Ok(()), Wal => { let lsn = store.wal.as_ref().unwrap().shard_for(st.id).reserve_and_stage(RecordKind::Append, st.id, target - wire.len() as u64, wire); store.wal...shard_for(st.id).wait_durable(lsn).await; Ok(()) } }`. The `stream_offset` is the pre-append logical offset = `target − wire.len()`. Add `Store.wal: Option<Arc<WalSet>>` (default `None`). Keep all 3 sites calling this one helper (DRY). **Step 4:** PASS + full suite green (strict/fast byte-for-byte unchanged). **Step 5:** `git commit -m "feat(wal): DurabilityMode (strict|wal|fast) + wal-mode buffered double-write append"`

---

### Task 6: Checkpoint + WAL recycle (`src/wal/shard.rs`, `store.rs`)

**Files:** Modify `src/wal/shard.rs` (+ a `store` callback to fsync per-stream files). Test: inline.

**Interfaces — Produces:** `pub async fn Shard::checkpoint(&self, store: &Arc<Store>)` — batched `fdatasync` of the per-stream files this shard touched since last checkpoint (gather touched stream_ids; call the existing per-stream-file `fdatasync`/`sync_data`), persist `checkpoint_lsn` (a small `wal/<i>/checkpoint` file), recycle segments fully below it. Ordering: **fsync files THEN recycle** (§7).

- [ ] **Step 1: failing test** — after checkpoint, segments below checkpoint_lsn are removed AND a per-stream file was fsync'd; appends keep acking during a stalled checkpoint (non-blocking). **Step 2:** FAIL. **Step 3:** Implement per §7 (touched-set tracked by the committer; recycle = unlink segment files whose max lsn < checkpoint_lsn). **Step 4:** PASS. **Step 5:** `git commit -m "feat(wal): per-shard checkpoint (batched per-stream fsync) + segment recycle"`

---

### Task 7: Recovery — per-shard replay, file_base map, frontier skip, tail repair (`src/wal/recovery.rs`)

**Files:** Create `src/wal/recovery.rs`. Modify `store.rs` recovery to call it after the sidecar pass. Test: inline.

**Interfaces — Produces:** `pub fn recover(store: &Arc<Store>, wal: &Arc<WalSet>) -> io::Result<()>` — per shard, parallel: from `checkpoint_lsn` decode records to first `Torn`; for each `Append`, look up the stream's `file_base` (from the already-recovered sidecar state), SKIP if `stream_offset < file_base`, else write payload at `file_pos = stream_offset - file_base` and advance the stream tail. WAL replay does NOT allocate ids (§9).

- [ ] **Step 1: failing test** — no-loss + no-torn + frontier skip + file_base mapping:

```rust
#[tokio::test]
async fn wal_recovery_repairs_tail_no_torn_no_loss() {
    // wal-mode: append 3 records (durable) to a binary stream, append a 4th but corrupt its
    // WAL payload (torn), also leave a torn page-cache tail in the per-stream file; drop store;
    // reopen + recover. CONCRETE assertions:
    //   - std::fs::metadata(stream_file).len() == file_base + (len(r1)+len(r2)+len(r3))  (4th discarded)
    //   - std::fs::read(stream_file) bytes == r1‖r2‖r3 exactly (byte-identical, whole records only)
    //   - a stream pre-seeded with file_base=K: any replayed WAL record with stream_offset < K is SKIPPED
    //     (assert its bytes are NOT re-written into the live file / no out-of-range write)
    // (legacy comment retained below)
    // assert: file ends at the 3rd whole record (4th discarded), bytes byte-identical,
    // a record with stream_offset < file_base is skipped (seed a compacted stream).
}
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement per §9 (run after `recover_one_inner`; per-shard `tokio::spawn`/join). **Step 4:** PASS. **Step 5:** `git commit -m "feat(wal): per-shard recovery — replay + file_base-mapped tail repair (no torn, no loss)"`

---

### Task 8: `--durability wal` + `--wal-shards` flags, `relaxed`→`fast` rename, wiring (`main.rs`)

**Files:** Modify `src/main.rs` (flag parse + wiring) **and `src/handlers.rs`** (the `durability_flag_defaults_strict_and_flips` test lives in `mod durability_tests`, ~`handlers.rs:2154`, not main.rs). Test: that flag test (now `DurabilityMode`) + a wiring smoke.

**Interfaces — Consumes:** WalSet, recovery, DurabilityMode. **Produces:** CLI: `--durability strict|wal|fast` (rename the existing `relaxed` arm at `main.rs:130` → `fast`; map to `DurabilityMode`), `--wal-shards N`. On `wal`: `WalSet::open(data_dir, n, available_parallelism())` — pass the `available_parallelism()` value already computed at `main.rs:156` as `default_n` (exit 2 on a `--wal-shards` mismatch), wire `store.wal`, run `recover`, `spawn_committers`, spawn per-shard checkpoint ticker — all inside `rt.block_on` before `serve`.

- [ ] **Step 1:** update the `durability_flag_defaults_strict_and_flips` test in `handlers.rs::durability_tests` → `DurabilityMode` (strict default; parse wal/fast; bad value exit 2). **Step 2:** FAIL. **Step 3:** Implement the arm + wiring (pass `available_parallelism()` as `default_n`). **Step 4:** PASS + `cargo build`. **Step 5:** `git commit -m "feat(wal): --durability wal + --wal-shards flags; relaxed→fast; build+spawn committers/checkpoint/recovery"`

---

### Task 9: Telemetry — per-shard batch histogram (`src/wal/telemetry.rs`)

**Files:** Create `src/wal/telemetry.rs`. Modify `shard.rs` (record per-commit batch count). Test: inline.

**Interfaces — Produces:** `ShardStats { records_committed, fsync_count, last_batch, batch_hist (hdr or buckets), durable_lsn, checkpoint_lsn, size_bytes, segments }`; `run_emitter(walset)` 1 Hz prints `WAL_STATS shard=<i> ...` with per-shard `avg/p50/p99/max` batch + aggregate (§11). Mirror the relaxed-branch `telemetry` emitter pattern.

- [ ] **Step 1:** test — a commit of K records updates `last_batch=K`, `avg=records/fsync`. **Step 2:** FAIL. **Step 3:** Implement (committer snapshots batch size = records advanced this fsync → histogram). **Step 4:** PASS. **Step 5:** `git commit -m "feat(wal): per-shard batch-size telemetry (WAL_STATS) + 1Hz emitter"`

---

### Task 10: End-to-end durability + sharding tests

**Files:** Test-only (new `#[cfg(test)]` in `wal/recovery.rs` or a `wal/tests.rs`).

- [ ] **Step 1:** e2e tests (per §13): (a) **no-loss** — ≥2 shards, append K, commit, drop+reopen+recover → all acked present byte-identical, un-acked absent; (b) **no-torn-JSON** — torn file tail + framed WAL → repaired to whole records, read returns valid JSON; (c) **sharding** — streams hashing to different shards recover in parallel; a `stream_offset < file_base` record skipped; (d) **N-stability** — reopen with different `available_parallelism` → same shard resolution; `--wal-shards` mismatch exit 2; (e) **checkpoint non-blocking** — stalled checkpoint, appends keep acking, `size_bytes` grows. **Step 2:** FAIL/RED for any not-yet-covered. **Step 3:** make green (most logic exists from Tasks 1–9; this is the integration gate). **Step 4:** `cargo test -p durable-streams-server` full green + `cargo clippy --all-targets` clean. **Step 5:** `git commit -m "test(wal): e2e no-loss / no-torn / sharding / N-stability / non-blocking checkpoint"`

---

## After all tasks

- `cargo test -p durable-streams-server` green; `cargo clippy --all-targets` clean; `strict`/`fast` unregressed (WAL inert when off).
- **Bench (ds-rust-bench, GKE):** `--durability strict|wal|fast` cardinality sweep + single-stream micro-cell; report per-shard batch distribution; check §14 falsifiable bars (p99 ≤ strict; throughput ≥ strict at N≤1000 & within 10% at 10k; single-stream ≥ 0.7× strict; batch p50 grows).

## Spec coverage map

§2 modes → Task 5,8 · §3 architecture/data-path → Task 5 · §4 framing → Task 1 · §5 sharding → Task 4,8 · §6 committer → Task 3 · §7 checkpoint → Task 6 · §8 reads-unchanged → (no task; verified by strict/fast suite + Task 5 "bytes in per-stream file") · §9 recovery → Task 7 · §10 DurabilitySink → Task 5 · §11 telemetry → Task 9 · §12 config → Task 8 · §13 tests → Tasks 1-10 · §14 criteria → bench (post-merge).

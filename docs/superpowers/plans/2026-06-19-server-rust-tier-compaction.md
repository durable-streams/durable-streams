# Live-file compaction (server-rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use `- [ ]` tracking.

**Goal:** Reclaim a tiered stream's redundant sealed prefix from the live data file by rewriting it to hold only `[sealed_offset, tail)`, without degrading reads/appends.

**Architecture:** Split `base_offset` (fork point, immutable) from a new `file_base` (live-file logical start, advances on compaction). Compaction runs after the seal pass, under the per-stream appender lock: write residual tail → temp, fsync, persist a `pending_compaction` intent, atomic-rename over the live file, swap the read `(file, file_base)` pair under `shared.write()` + the appender handle, persist cleared meta. Crash-safe via the intent log + `tail`-anchored recovery. No new dependencies (tokio only).

**Tech Stack:** Rust, tokio, std::fs (FileExt::read_exact_at, rename, fsync).

## Global Constraints

- Pre-1.0; changeset type `patch`.
- No new crate dependencies (project is tokio-only by design).
- Reads must stay lock-free on the hot cached path; only the `Body::FileRange`
  (cold/large) path may take an extra `shared.read()`.
- Durability/crash-safety invariants from the spec
  (`docs/superpowers/specs/2026-06-19-server-rust-tier-compaction-design.md`).
- Invariant: `base_offset ≤ file_base ≤ sealed_offset ≤ tail`.
- `Meta` additions use `#[serde(default)]` (forward/backward compatible).

---

### Task 1: Split `base_offset` → introduce `file_base` (no compaction yet)

Pure refactor: `file_base` is introduced everywhere file-mapping happens, but is
always equal to `base_offset` (nothing advances it yet). All existing tests must
still pass; behavior is byte-identical.

**Files:**

- Modify: `src/store.rs` — `Shared` (+`file: Arc<File>`, +`file_base: u64`),
  remove `StreamState.file` (move read handle into `Shared`), `create`,
  `recover_one_inner`, `SyncCoalescer` `covers`, `Meta` (+`file_base: Option<u64>`, +`pending_compaction: Option<PendingCompaction>`), `write_meta_sync`, test
  helper `append_wire`, add `PendingCompaction` struct + `StreamState.compaction`
  intent cell.
- Modify: `src/tier.rs` — `seal_loop` (`file_lo` and live read via shared),
  `resolve_range` (live slice via consistent `(file, file_base)`).
- Modify: `src/handlers.rs` — `write_wire` and splice-append tail computation.

**Interfaces produced (used by later tasks):**

- `struct PendingCompaction { new_file_base: u64, tail: u64 }` (in store.rs, `pub`,
  `Serialize/Deserialize/Clone/Copy`).
- `StreamState.compaction: StdMutex<Option<PendingCompaction>>`.
- `Shared.file: Arc<File>`, `Shared.file_base: u64`.
- `Meta.file_base: Option<u64>`, `Meta.pending_compaction: Option<PendingCompaction>`.
- Read consistent pair: `let s = st.shared.read().unwrap(); (s.file.clone(), s.file_base)`.

Mapping sites to switch `base_offset → file_base` (file-local math only; fork
routing keeps `base_offset`):

- `store.rs` SyncCoalescer: `covers = s.tail - s.file_base`.
- `store.rs` recover: `let file_base = meta.file_base.unwrap_or(meta.base_offset); let tail = file_base + written;`
- `store.rs` `append_wire` test helper: `tail = file_base + ap.written`.
- `handlers.rs` `write_wire`: `let tail = { let s=st.shared.read().unwrap(); s.file_base } + ap.written;` (then take write lock to set tail) — or read `file_base` inside the existing write guard.
- `handlers.rs` splice append: same.
- `tier.rs` seal_loop: `file_lo = sealed_offset - file_base` and read the live region from `shared.file`.
- `tier.rs` resolve_range: `Segment { file: s.file.clone(), file_start: live_lo - s.file_base, len }` under one `shared.read()`.

- [ ] Step 1: Add `PendingCompaction` struct + `Meta` fields (`#[serde(default)]`) + `Shared` fields + `StreamState.compaction`. Remove `StreamState.file`; init `Shared.file`/`file_base` in `create` & `recover`. Update `write_meta_sync` to emit `file_base` (from `shared`) and `pending_compaction` (from the cell).
- [ ] Step 2: Switch the mapping sites above to `file_base`. Update `seal_loop`/`resolve_range` to read the consistent pair from `shared`.
- [ ] Step 3: `cargo build` — fix compile errors.
- [ ] Step 4: `cargo test` — all existing tests pass (refactor is behavior-preserving).
- [ ] Step 5: Add test `file_base_defaults_to_base_offset_on_recovery` (old sidecar without `file_base` recovers correct tail/content). Run it.
- [ ] Step 6: Commit `refactor(server-rust): split base_offset into file_base for live-file mapping`.

### Task 2: Config knob `--tier-compact-bytes`

**Files:**

- Modify: `src/tier.rs` — `TierConfig { ..., compact_bytes: u64 }` (default
  `64 * 1024 * 1024`; `Default` impl).
- Modify: `src/main.rs` — parse `--tier-compact-bytes` into `compact_bytes`.

- [ ] Step 1: Add `compact_bytes: u64` to `TierConfig` + default 64 MiB.
- [ ] Step 2: Parse `--tier-compact-bytes` in `main.rs` (mirror `--tier-segment-bytes`).
- [ ] Step 3: `cargo build`. Commit `feat(server-rust): add --tier-compact-bytes config`.

### Task 3: Compaction core (`compact_one` + `maybe_compact`)

**Files:**

- Modify: `src/tier.rs` — add `compact_one`/`maybe_compact`; call after
  `seal_loop` returns inside `maybe_seal` (same per-stream guard → mutually
  exclusive with sealing).
- Test: `src/store.rs` `tier_tests` — reclaim + read-back + threshold.

Algorithm (`compact_one`, under appender lock):

```
cut = sealed_offset; let s = shared.read(): old_base = s.file_base, T = s.tail
if cut <= old_base { return }                       // nothing to reclaim
tmp = file_path.with_extension("compact.tmp")
write file-local [cut-old_base, T-old_base) from old file -> tmp; fdatasync tmp; fsync dir
set st.compaction = Some(PendingCompaction{ new_file_base: cut, tail: T }); write_meta_sync(durable)
rename(tmp, file_path); fsync dir
open new fd (read+append) -> Arc; { let mut s = shared.write(); s.file = fd.clone(); s.file_base = cut }
ap.file = fd; ap.written = T - cut
st.compaction = None; write_meta_sync(durable)
```

Eligibility in `maybe_compact`: tiering on, `compact_bytes > 0`,
`sealed_offset - file_base >= compact_bytes`.

- [ ] Step 1: Write failing test `compaction_reclaims_live_file`: local tier `segment_bytes=64KiB`, `compact_bytes=128KiB`; append 512 KiB; `maybe_seal`; assert live file size ≈ `tail - sealed_offset` (≤ ~1 segment), full `read_logical(0,total)` == payload, boundary read correct, manifest segment count unchanged.
- [ ] Step 2: Run it → fails (no compaction).
- [ ] Step 3: Implement `compact_one`/`maybe_compact`; invoke from `maybe_seal`.
- [ ] Step 4: Run test → passes.
- [ ] Step 5: Add `compaction_respects_threshold` (below `compact_bytes` → live file NOT shrunk; reads exact). Run.
- [ ] Step 6: `cargo test` (all). Commit `feat(server-rust): compact live file after tiering offload`.

### Task 4: Crash-safe recovery of `pending_compaction`

**Files:**

- Modify: `src/store.rs` `recover_one_inner` — when `meta.pending_compaction` is
  `Some(p)`: `file_base = p.tail.checked_sub(written)`; if `None`/inconsistent
  (`p.tail < written`) fall back to `meta.file_base.unwrap_or(base_offset)`; set
  `tail = file_base + written`; keep the cell so the next meta write clears it
  (set `meta_dirty`). Always delete a stray `<data>.compact.tmp` on boot.

- [ ] Step 1: Write failing test `recovery_after_compaction_intent` mimicking each crash window: build a store, append+seal+compact, then hand-craft the on-disk state for (a) crash before rename (old full file + pending meta), (b) crash after rename (new file + pending meta), (c) clean post-compaction (new file, no pending). Reload via `Store::new_with_tier` and assert `tail` and full read-back are exact in all three.
- [ ] Step 2: Run → fails.
- [ ] Step 3: Implement recovery branch + tmp cleanup.
- [ ] Step 4: Run → passes. `cargo test`. Commit `fix(server-rust): crash-safe recovery for live-file compaction`.

### Task 5: Fork-after-compaction safety

**Files:**

- Test: `src/store.rs` `tier_tests`.

- [ ] Step 1: Write test `fork_reads_compacted_parent`: seed+seal+compact a parent; create a fork at `base_offset = parent.tail` (or a mid offset) with `parent` link; `read_logical` across the parent's compacted region; assert byte-exact.
- [ ] Step 2: Run → passes (resolve_range routes sealed parent offsets to the manifest). If it fails, fix routing. Commit `test(server-rust): fork reads across compacted parent`.

### Task 6: Docs + changeset

**Files:**

- Modify: `ARCHITECTURE.md` (replace the "live-file reclaim deferred" note with the
  compaction description), `README.md` (replace "not yet reclaimed" note; document
  `--tier-compact-bytes`).
- Create: `.changeset/<name>.md` (`patch`).

- [ ] Step 1: Update both docs (sentence-case headings per CLAUDE.md). Add changeset. Commit `docs(server-rust): document live-file compaction`.

### Task 7: Benchmark — verify no regression

- [ ] Step 1: `./.bench-local.sh compaction` (release build into `/tmp/ds-bench-target`).
- [ ] Step 2: Compare to `results-baseline.json`: `read1k`/`read1m`/`append100` within ~5% rps; `append_tier` rps not below baseline beyond noise; `append_tier_disk.live_file_bytes` drops sharply vs ~164 MB baseline.
- [ ] Step 3: If `append_tier` degrades, escalate to copy-outside-lock critical section and re-measure. Report results.

## Self-Review

- **Spec coverage:** data-model split (T1), config (T2), algorithm (T3), crash
  safety (T4), fork safety (T5), docs/changeset (T6), benchmark bar (T7). ✓
- **Placeholders:** none — code sketches + exact commands provided.
- **Type consistency:** `PendingCompaction{new_file_base,tail}`, `file_base`,
  `compact_bytes` used consistently across tasks. ✓

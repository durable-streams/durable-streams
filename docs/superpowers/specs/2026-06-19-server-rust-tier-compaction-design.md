# Live-file compaction for tiering (server-rust)

Date: 2026-06-19
Package: `packages/server-rust`
Status: design — approved approach, pending spec review

## Problem

With tiering on (`--tier`), the server seals the unsealed prefix into fixed-size
segments, copies each to a chunk file, uploads it to object storage, and unlinks
the chunk file. But **the live data file's sealed prefix is never reclaimed**
(`tier.rs:447-456`): hole-punching it raced with in-flight lazy reads
(`sendfile` / `Body::FileRange`) into the just-sealed tail, so the punch was
deliberately removed (`0e4b6d4e`, after corruption fix `ef93b246`). The live file
therefore retains a full, redundant copy of everything already in cold storage.

Measured locally (3×10s tiered appends, 100 B): `live_file = 164 MB` while
`cold_dir = 160 MB` — ~160 MB of pure redundancy that grows unbounded with the
stream.

## Goal

Reclaim the live file's sealed prefix safely, **without** degrading the hot read
path (lock-free `sendfile`, ~147k rps locally) or the append path, and without
re-introducing the read/punch race.

Chosen approach: **compaction** — periodically rewrite the live file so it holds
only `[sealed_offset, tail)`, dropping the redundant sealed prefix. This keeps
reads lock-free (in-flight readers drain off the old fd via the existing
unlink-after-open pattern) and is portable (no `fallocate`/`F_PUNCHHOLE`, works
on macOS dev + Linux prod, shrinks real disk on every filesystem). Trade-off
accepted: bounded, tunable write-amplification (rewrite the hot tail once per
reclaim threshold).

### Non-goals

- Hole-punch / epoch-refcount read coordination (the rejected alternative).
- Reclaiming the _unsealed_ tail (it is live, by definition not reclaimable).
- Changing the cold-tier (object storage) format or the seal/offload protocol.
- Compaction for streams with tiering off (nothing seals → nothing to reclaim).

## Decisions (agreed)

1. **Trigger: threshold-based.** Compact a stream once its reclaimable bytes
   (`sealed_offset − file_base`) reach `--tier-compact-bytes` (default 64 MiB;
   `0` disables). Bounds write-amplification while capping redundant disk.
2. **Default: on when tiering is on**, tunable via `--tier-compact-bytes` and
   disable-able (set to `0`). The conservative kill-switch addresses the prior
   reclaim-corruption history.
3. **Critical section: simple first.** v1 performs the whole rewrite under the
   per-stream appender lock. The reclaimable tail is bounded (≤ ~a segment or two
   of live data), so the append stall is small. Optimize (copy-outside-lock +
   residual catch-up) only if the benchmark shows append degradation.

## Core data-model change: split `base_offset`

Today `base_offset` does double duty (`store.rs`, `tier.rs:50`):

- **Fork point** — logical offsets `< base_offset` route to the `parent` chain
  (`resolve_range`, `tier.rs:663`).
- **Live-file logical start** — a live-region read maps `file_pos = logical −
base_offset` (`tier.rs:374`, `handlers.rs:558`), and recovery derives
  `tail = base_offset + file_size` (`store.rs:532-533`).

Compaction advances the live file's start without moving the fork point, so these
two meanings must split:

- `base_offset` (unchanged): the fork point. Immutable for a stream's lifetime.
- **`file_base`** (new): logical offset of the live data file's first byte.
  Equals `base_offset` until the first compaction, then advances to
  `sealed_offset`. Invariant: `base_offset ≤ file_base ≤ sealed_offset ≤ tail`.

All live-region offset math switches from `base_offset` to `file_base`:

- read mapping: `file_pos = logical − file_base`
- recovery: `tail = file_base + file_size`
- appender: `tail = file_base + written` (replaces `base_offset + written`,
  `handlers.rs:558,1173`).
- seal: the sealable-prefix read in `seal_loop` (`file_lo = sealed_offset − base`,
  `tier.rs:374`) becomes `sealed_offset − file_base`.

Fork routing (`resolve_range`'s `start < base_offset` check) keeps using
`base_offset` — unchanged.

## Concurrency: consistent (file, file_base) for readers

Reads must observe the live file handle and its `file_base` as a consistent pair;
a torn read (old handle + new base, or vice-versa) would read wrong bytes.

- The read-side live handle + `file_base` move under the existing
  `shared: RwLock<Shared>` (already taken on the read path for the tail
  snapshot). Readers clone the handle and read `file_base` under one `read()`
  guard — no new lock, no new dependency. This only affects `Body::FileRange`
  (cold/large reads); the hot small-read path is served from the resident
  `last_chunk` cache and never touches the file, so the ~147k-rps number is
  unaffected.
- The append-side handle lives in `Appender` (`store.rs:74`) and is mutated under
  the appender lock — which compaction holds during the swap.
- (Alternative if profiling ever shows the clone-under-lock matters:
  `ArcSwap<LiveFile{file, file_base}>`. Not needed for v1.)

## Compaction algorithm (v1, under the appender lock)

Runs as a post-append background pass, alongside / after `maybe_seal`
(`tier.rs:333`). Eligibility: tiering on, `--tier-compact-bytes > 0`, and
`sealed_offset − file_base ≥ tier_compact_bytes`. Compaction is **mutually
exclusive with the seal pass** for a stream — it runs after `seal_loop` returns,
under the same per-stream guard `maybe_seal` already holds (`tier.rs:337`) — so
seal and compaction never touch the live file or `file_base` concurrently. One
compaction per stream at a time.

Let `cut = sealed_offset`, `old_base = file_base`.

1. Acquire the appender lock (freezes `tail`; no concurrent appends). Snapshot
   `tail = T`, `cut`. Live file currently holds `[old_base, T)`.
2. Write residual `[cut, T)` (file-local `[cut − old_base, T − old_base)`) to a
   temp file `<data>.compact.tmp`; `fdatasync` it; `fsync` the data dir.
3. `write_meta_sync` recording `pending_compaction = { new_file_base: cut,
tail: T }` (intent log). Keep `file_base = old_base` for now. fsync.
4. `rename(tmp, live_path)` — atomic content swap. `fsync` the data dir.
   In-flight readers holding the old fd keep reading the old inode; it is freed
   when they drop.
5. Open a fresh fd on `live_path` → new `Arc<File>`. Under `shared.write()`:
   publish `(new file, file_base = cut)`. Update `Appender.file = new Arc`,
   `Appender.written = T − cut`.
6. `write_meta_sync` with `file_base = cut`, `pending_compaction = None`. fsync.
7. Release the appender lock.

Reclaiming the sealed prefix is independent of Local vs Remote placement: every
offset `< sealed_offset` is covered by a manifest segment (chunk file and/or
remote object), so the live copy is always redundant. Compaction never advances
`file_base` past `sealed_offset` and never touches the manifest or segments.

## Crash safety

`pending_compaction { new_file_base, tail }` makes the rewrite atomic against a
crash. Because compaction holds the appender lock end-to-end, `tail` is frozen at
`T`, so on boot the live file is _either_ the pre-rename full file `[old_base, T)`
_or_ the post-rename compacted file `[cut, T)` — both end at `T`.

Recovery (`recover_one_inner`, `store.rs:506`):

- **No `pending_compaction`:** `file_base = meta.file_base` (default
  `meta.base_offset` when absent — back-compat); `tail = file_base + file_size`.
- **`pending_compaction` present:** set `file_base = pending.tail − file_size`
  (yields `old_base` if the old file is on disk, `cut` if the new one is);
  `tail = pending.tail`; clear the marker on next meta write. This is correct for
  either crash point.
- Always: delete a stray `<data>.compact.tmp` on boot.

Ordering rule: meta intent (step 3) is fsynced **before** the destructive rename
(step 4), and the cleared marker (step 6) **after** — mirroring the existing
seal/offload `Local→Remote` flip that persists meta before `unlink`
(`tier.rs:505-515`).

## Fork interaction

Forks read parent offsets `< fork.base_offset` by recursing into `parent`
(`resolve_range`, `tier.rs:663`). Compacting a parent only removes
`[old_base, sealed_offset)` from the parent's live file — all sealed, hence served
from the parent's manifest segments (chunk/remote), which compaction leaves
intact. Any _unsealed_ parent bytes a fork might need (`≥ parent.sealed_offset`)
stay in the parent's live file. So parent compaction is fork-safe; forks never
read a parent's compacted-away region from the live file. Each fork compacts its
own file under the same rules.

## Config / flags

- `--tier-compact-bytes <N>` (`main.rs` arg parse, into `TierConfig`): reclaim
  threshold in bytes. Default `67108864` (64 MiB). `0` disables compaction.
- No new `--tier` mode; compaction is part of `local`/`s3` tiering when the
  threshold is > 0.
- Document in `README.md` (replace the "not yet reclaimed" note) and
  `ARCHITECTURE.md` (replace "live-file reclaim deferred" with the compaction
  description). Add a changeset (`patch`).

## Meta sidecar additions

`Meta` (`store.rs:883`), both `#[serde(default)]` for forward/backward compat:

- `file_base: Option<u64>` — `None` in old sidecars → recovery uses
  `base_offset`.
- `pending_compaction: Option<PendingCompaction>` where
  `PendingCompaction { new_file_base: u64, tail: u64 }`.

## Testing

Per CLAUDE.md, protocol-visible behavior goes in conformance; internal mechanics
(disk reclaim, crash recovery) need Rust-level tests.

1. **Read-back correctness (protocol-level):** with tiering + a tiny
   `--tier-compact-bytes`, append past several thresholds, then read the **full**
   history (incl. compacted-away offsets) and ranges spanning the
   sealed/unsealed boundary; assert byte-exact. Express as a server-conformance
   case if the Rust server is covered by that suite; otherwise a Rust
   integration test.
2. **Reclaim happened (Rust):** after compaction, assert the live data file size
   ≈ `tail − sealed_offset` (hot tail only), manifest/segments unchanged, cold
   data intact.
3. **Crash recovery (Rust):** construct each crash window (after step 2 / after
   step 3 / after step 4 / after step 6) by leaving the corresponding on-disk
   state, then reload the store and assert `tail` and full-history content are
   exact, and the temp file is gone.
4. **Fork-after-compaction (Rust):** fork a stream whose parent was compacted;
   read the fork across the parent's compacted region; assert byte-exact.
5. **Regression:** the existing conformance suite passes with tiering on.

## Verification / benchmark bar

Re-run `.bench-local.sh compaction` and compare to baseline
(`results-baseline.json`):

- `read1k`, `read1m`, `append100`: within run-to-run noise (≤ ~3–5% rps) — these
  paths are unchanged (no tier / hot cache).
- `append_tier`: rps **not below baseline beyond noise**; p99 not materially
  worse (this is where compaction's extra background rewrite could bite — the
  whole point of measuring).
- `append_tier_disk.live_file_bytes`: **drops sharply** (~164 MB → a couple
  segments) — proof compaction reclaims, while `cold_dir_kb` stays ~constant.

If `append_tier` degrades, escalate the critical section to the optimized
copy-outside-lock variant (decision 3 fallback) and re-measure.

## Risk register

- **Torn (file, file_base) read** → wrong bytes. Mitigation: publish the pair
  under `shared.write()`, read under `shared.read()`.
- **Crash mid-swap** → lost/short tail. Mitigation: `pending_compaction` intent
  log + `tail`-anchored recovery; meta-before-rename ordering.
- **Append stall** from the locked rewrite. Mitigation: bounded tail; benchmark
  gate; optimized-critical-section fallback.
- **Fork reads a compacted parent region.** Mitigation: only sealed (segment-
  backed) bytes are reclaimed; `resolve_range` routes them to the manifest.

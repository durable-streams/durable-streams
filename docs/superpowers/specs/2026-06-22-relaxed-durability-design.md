# Relaxed Durability Mode — Design Spec

**Repo:** `durable-streams` · **Branch:** `vbalegas/relaxed-durability` (off `vbalegas/streams-rust`)
**Crate:** `packages/server-rust` · **Date:** 2026-06-22

**Goal:** An opt-in `--durability relaxed` mode that **acks an append as soon as the
bytes are in the page cache — no `fdatasync` on the hot path.** Durability for
cold/sealed data continues to come from the existing S3 tier; durability for the
recent hot tail will come from replication (a later, separate cut). `strict`
(today's per-stream group-commit fsync) stays the **default** and is unchanged.

## 1. Motivation

Two GKE experiments (see `ds-rust-bench` results) established:

- The shared-WAL approach is a dead end: with **all** fsync removed it still
  collapsed to ~500 ops/s (~100× below reference). Its materialize-back data path
  (copies + double-write + single materializer) is the wall, not fsync.
- **fsync is the only meaningful local-durability cost on the reference path**, and
  only at low cardinality: dropping it gave reference **2.4× at N=10**, falling to
  **~1.13× at N=10,000** (parallel per-stream fsync hides latency at scale).

So the cheap, high-confidence win is to **stop fsyncing on the append hot path** and
let durability come from S3-offload (cold) + replication (hot tail, future). This
spec is that win. Replication is explicitly out of scope here.

## 2. Durability stance (decided)

| mode               | ack happens after                                           | crash loss                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict` (default) | the covering `fdatasync` (today's `SyncCoalescer::sync_to`) | none                                                                                                                                                           |
| `relaxed`          | the `write()` into the page cache (no `fdatasync`)          | only the **un-sealed, un-offloaded hot tail** (≤ ~`segment_bytes`/stream) on an **OS/power crash**; a **process crash loses nothing** (page cache is the OS's) |

Sealed segments offloaded to S3 are durable regardless of local fsync, so the
at-risk window in `relaxed` is just the recent hot tail. "No local fsync" applies to
the **append/close hot path only** — the infrequent off-path integrity commits
(seal/offload manifest, close-meta) keep their fsync (see §6/§7).

Note: per-append **producer-dedup / last-access** state is already persisted only by a
**debounced, non-durable** meta flush in **both** modes (a ≤~100 ms crash window that
exists today under `strict`). `relaxed` does not widen it — it changes only the data
`fdatasync` — so `strict`'s guarantees are genuinely untouched.

## 3. Scope

- **In:** `--durability strict|relaxed` flag; a `DurabilityMode` threaded into the
  append + close paths; `relaxed` skips `sync_to`; `strict` byte-for-byte unchanged;
  tests; benchmark.
- **Reused as-is (already on the base):** seal → offload → unlink → compact retention
  (`tier.rs`) and placement-aware cold reads. This **is** "delete old chunks of the
  log"; this cut only verifies it under `relaxed` and at scale. No changes to it.
- **Out (deferred):** replication; replication-gated local reclaim; per-request
  durability selection; dropping the off-path manifest fsync.

## 4. Hot-path edits — gate EVERY `sync_to` call site

`sync_to` is the covering data `fdatasync`. It is awaited before the ack on **three**
append hot paths, and **all three must be gated** on `DurabilityMode` — missing any one
silently keeps strict's fsync cost there (the splice path is the one the benchmark
actually exercises):

| call site          | path                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `handlers.rs:500`  | PUT create-with-initial-body (`CreateResult::Created`)                                           |
| `handlers.rs:908`  | mainline repeated append + close (`handle_append_inner`)                                         |
| `handlers.rs:1215` | binary **splice** fast path (`--splice-appends`, Linux) — the high-throughput binary-append path |

Shape of each (illustrated for the mainline append, ~L908):

```
write_wire(&st, &mut ap, &wire)        // bytes → live data file (page cache)
st.sync.sync_to(file, &st, target)     // STRICT: await fdatasync covering `target`
→ ack 2xx                              // only after the sync
maybe_seal_bg(store, &st)              // background seal/offload — already off the ack path
```

- `strict`: unchanged (all three sites await `sync_to`).
- `relaxed`: **skip `sync_to`** at all three sites; ack 2xx as soon as the bytes are
  written to the page cache. `maybe_seal_bg` still fires after the ack (unchanged).

Close path (within `handle_append_inner`): `handlers.rs:908` data `fdatasync` →
`:918` durable close-meta commit → `:924` `closed_durable` exposure. `relaxed` **skips
the data fdatasync** (the `:908` gate above) but **keeps the durable close-meta
commit** (off-path integrity), then exposes the closure. The recovered tail = on-disk
file size and `closed_durable` comes from the durable meta, so readers still never
observe EOF before the close-meta commit. Caveat (relaxed): the _closedness_ never
rolls back, but the closed _position_ can — the skipped data fdatasync means an
OS/power crash can recover a shorter closed tail. The full position-monotonicity
guarantee (the closed tail never shrinks) is **strict-only**; under relaxed a shorter
recovered tail is within the stated contract (a closed stream is hot tail ending in a
close).

The mode is a **module-global flag** in `handlers.rs` — a process-global `AtomicBool`
(`DURABILITY_RELAXED`) set once at startup from `--durability` via
`set_durability_relaxed`, read on each hot path with a single `Relaxed` load through
`durability_relaxed()`. This deliberately mirrors the established `SPLICE_APPENDS` /
`READ_OFFLOAD` startup-flag pattern (`engine_raw.rs`) rather than threading a `Store`
field into every call site (notably the create site). A `Relaxed` load is free — no
lock, no contention — so `strict` keeps its exact cost. (An earlier draft of this spec
described a `Copy` `DurabilityMode` enum field on `Store`; the implementation realizes
the same semantics — server-wide, set once at startup, read by value on the hot path —
via the global-flag convention. The single gating chokepoint is `maybe_sync_on_ack`,
which all three append/close `sync_to` sites route through.)

## 5. Off-path operations — unchanged

`maybe_seal` / `offload_one` / `maybe_compact` already run **after** the ack and never
block it. They run identically on a `relaxed` ack: sealed segments upload to S3
(durable on their own), the live file compacts (`file_base` slides), and reads below
`file_base` resolve to sealed segments (local chunk or remote BlobStore). No changes.

## 6. Recovery — unchanged and O(1) per stream

`store.rs::recover_one_inner` already **stats** the live data file
(`file.metadata()?.len()`) to derive the tail; the data file is raw contiguous wire
bytes, so **its size _is_ the tail**. There is no log to replay or scan.

- `relaxed` loses only the un-flushed tail suffix on an OS/power crash. Binary streams
  recover any byte prefix (tail = size) — always valid.
- **JSON torn-tail limitation (relaxed only).** Recovery sets `tail = file_size`
  unconditionally; it does **not** trim a torn trailing JSON record. A sound _bounded_
  trim is **not feasible from the data file alone**: the JSON wire is bare
  concatenated `value,` records with no length framing and no per-record durable
  offset index, and the boundary finder (`last_json_value_boundary`) is a forward
  state machine that must start from a known-clean position (depth 0, not in-string).
  A pure tail-read can start _inside_ a JSON string/array and is therefore unsound
  (a `,` inside a string would be misread as a boundary); the only clean anchor,
  `sealed_offset`, is only near the tail when tiering is enabled, so the scan is not
  bounded in the general (tiering-off) case. Consequently, under `relaxed` an
  OS/power crash mid-write of a JSON record can leave a torn trailing record that the
  read path wraps into malformed JSON. **Open product decision** (see the docs page):
  document the relaxed+JSON limitation, or restrict `relaxed` to binary streams.
  Binary streams and `strict` (acks post-fsync at record boundaries) are unaffected.
- The off-path **manifest stays durable** (§7), so recovery needs **no manifest
  reconstruction** — sealed/offloaded segments and `file_base` are read back directly.

Per-stream recovery cost is therefore **O(1)** (one `fstat` + read the manifest);
total boot is `O(#streams)` + `O(#sealed-but-unoffloaded segments)` — identical to
`strict`. (This is also strictly better than the WAL, which replayed/torn-tail-scanned
`O(unflushed log)`.)

## 7. What relaxed drops vs keeps (the deliberate decision)

Relaxed changes **exactly one thing**: the append **data** covering `fdatasync`. It
does not touch the per-append metadata (which is already non-durable in both modes),
and it keeps the infrequent off-path manifest/close-meta durable.

| item                                                               | strict                                                                                | relaxed          | recovery impact                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| append **data** covering `fdatasync` (`sync_to` → `barrier_fsync`) | awaited before ack                                                                    | **dropped**      | **none** — the tail is recovered from `file.metadata().len()` (`store.rs:566`), never from a per-append fsync, so recovery stays **O(1)** |
| per-append tail / producer-dedup / last-access metadata            | **already non-durable** (debounced `write_meta_sync(durable=false)`, `store.rs:1086`) | unchanged        | already a ≤~100 ms crash window in **both** modes; relaxed does **not** widen it                                                          |
| seal/offload manifest, `file_base`, durable close-meta             | durable, off the hot path                                                             | **kept durable** | read back on boot (`reconcile_manifest_on_boot`); **no** manifest reconstruction                                                          |

The reason recovery is unaffected is **not** that we drop a "redundant metadata
fsync" (there is no per-append durable tail fsync today) — it is that the tail is
_derived from the file size_, so the data that survived OS writeback is exactly the
recovered prefix. Keeping the rare off-path commits durable keeps recovery O(1) and
unambiguous (no `O(#segments)` manifest rebuild).

## 8. Config

`--durability strict|relaxed`, default `strict`. Coexists with `--tier`,
`--splice-appends`, `--read-offload`, etc. Unknown values → `exit(2)` (matches the
existing arg-parse style).

## 9. Testing

**Unit / integration (`cargo test`):**

- `relaxed` append returns without entering the covering-fsync wait (assert the
  durable watermark is _not_ required for the ack); `strict` still waits.
- **All three `sync_to` sites are gated** — including the binary **splice** fast path
  (`handlers.rs:1215`): a `relaxed` binary/splice append acks without the covering
  fsync (regression guard that splice is gated, not silently strict).
- `relaxed` + `--tier local`: append past `segment_bytes` → the prefix seals and
  offloads; the offloaded bytes are present + correct in the blobstore; the live file
  compacts; a cold read returns byte-identical data.
- Recovery: `relaxed`, append N bytes, simulate crash (drop in-memory state, reopen
  from the data dir) → recovered tail == on-disk file size (a **consistent prefix**);
  sealed/offloaded segments intact; no corruption.
- `strict` default path is byte-for-byte today's behavior (regression guard).

**Benchmark (`ds-rust-bench`):** `--durability relaxed` vs `strict` on GKE — the
cardinality sweep + single-stream append. Expected: `relaxed` ≈ the measured
`ref-nofsync` (≈2.4× at N=10, ≈1.13× at N=10,000).

## 10. Success criteria

1. `--durability relaxed` acks without a hot-path `fdatasync`; throughput matches the
   `ref-nofsync` measurement within noise.
2. `--durability strict` (default) is byte-for-byte today's behavior — no regression.
3. Under `relaxed` + `--tier`, sealed data is durable in the cold tier, and recovery
   yields a consistent prefix (only the un-sealed, un-offloaded tail absent).
4. Recovery stays O(1) per stream — no new data scan introduced.

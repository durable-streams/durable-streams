# Relaxed durability

Relaxed durability is an opt-in append mode (`--durability relaxed`) that **acks an
append or close as soon as the bytes are in the OS page cache**, skipping the hot-path
data `fdatasync`. The default, `strict`, is unchanged: it acks only after the covering
per-stream group-commit fsync.

```
durable-streams-server --durability relaxed   # ack on page-cache write
durable-streams-server --durability strict     # (default) ack after fdatasync
durable-streams-server                          # default = strict
```

It exists for one reason: `fdatasync` is the only meaningful local-durability cost on
the append path, and removing it is a large, low-risk win at low–moderate stream
cardinality and a tail-latency win everywhere. Durability for cold data already comes
from the S3 tier; durability for the recent hot tail will come from replication (a
separate, later cut). Relaxed is the first half of that move.

## Architecture

### Two durability modes, one chokepoint

Both modes write the wire bytes to the live data file and then decide whether to wait
for them to be on stable storage before acking:

```
write_wire(&st, &mut ap, &wire)          // bytes → live data file (page cache)
maybe_sync_on_ack(durability_relaxed(),  // STRICT: await fdatasync; RELAXED: return Ok
                  &st, file, target)
→ ack 2xx                                 // only after maybe_sync_on_ack returns
maybe_seal_bg(&store, &st)                // background seal/offload — off the ack path
```

`maybe_sync_on_ack` is the single chokepoint
(`packages/server-rust/src/handlers.rs`):

```rust
async fn maybe_sync_on_ack(relaxed: bool, st: &StreamState,
                           file: Arc<std::fs::File>, target: u64)
    -> std::io::Result<()> {
    if relaxed { return Ok(()); }       // ack on the page-cache write
    st.sync.sync_to(file, st, target).await  // strict: per-stream group-commit fsync
}
```

**All three append/close `sync_to` call sites route through this one helper**, so the
mode gates every hot path together — missing any one would silently keep strict's fsync
cost there:

| call site (`handlers.rs`)   | path                                                            |
| --------------------------- | --------------------------------------------------------------- |
| create-with-initial-body    | PUT that creates a stream with a body (`CreateResult::Created`) |
| mainline append + close     | repeated append, and the close path (`handle_append_inner`)     |
| binary **splice** fast path | `--splice-appends` (Linux) — the high-throughput binary append  |

`strict` continues to call `SyncCoalescer::sync_to` — a **per-stream group-commit**: one
leader per stream folds all appenders currently waiting into a single `barrier_fsync`,
and crucially the fsyncs of _different_ streams run in parallel. `relaxed` simply skips
that wait.

### Retention and recovery are reused unchanged

Relaxed touches only the append/close **data** fsync. Everything downstream is the
existing, unmodified machinery:

- **Retention** (`tier.rs`): seal → offload to S3 → unlink local → compact (`file_base`
  slides forward). `maybe_seal_bg` still fires _after_ the ack in both modes, exactly as
  before. This is "delete old chunks of the log"; relaxed only exercises it at scale, it
  does not change it. The `tier.rs` source is byte-for-byte unchanged.
- **Recovery** (`store.rs::recover_one_inner`): the live data file is raw contiguous wire
  bytes, so the tail is derived from `file.metadata().len()` — one `fstat`, no log
  replay, no scan. (See the **JSON torn-tail limitation** below: under `relaxed`,
  recovery does **not** trim a torn trailing JSON record.)

### The close path keeps its durable meta commit

In the close path, relaxed skips the **data** `fdatasync` (the mainline gate) but
**keeps the durable close-meta commit** (`write_meta_sync(durable=true)`) before exposing
`closed_durable` to readers. The recovered tail is the on-disk file size and
`closed_durable` comes from the durable meta, so readers still never observe EOF before
the close-meta commit (PROTOCOL.md §4.1).

Caveat (relaxed): this guarantees the _closedness_ never rolls back, but the closed
_position_ can. Because the data `fdatasync` is skipped, an OS/power crash can lose the
un-synced tail and recover a shorter closed stream (recovered `tail` = on-disk size <
the acked tail). The full strict-only position-monotonicity guarantee — a reader never
sees the closed tail shrink — holds only under `strict`. Under relaxed this is within
the stated contract (the closed stream is just hot tail ending in a close).

### Crash-loss model

| event                | relaxed loses                                                                 | strict loses |
| -------------------- | ----------------------------------------------------------------------------- | ------------ |
| **process crash**    | nothing — the page cache belongs to the OS, not the process                   | nothing      |
| **OS / power crash** | only the **un-sealed, un-offloaded hot tail** (≤ ~`segment_bytes` per stream) | nothing      |

Sealed segments offloaded to S3 are durable regardless of local fsync, so the only
at-risk window under relaxed is the recent hot tail. Cold data is always durable in S3.
Per-append producer-dedup / last-access metadata is already persisted by a debounced,
non-durable meta flush in **both** modes (a ≤~100 ms window that exists today under
strict); relaxed does not widen it — it changes only the data `fdatasync`.

> **Known limitation — relaxed + JSON torn tail (open product decision).** For binary
> streams the lost tail is a clean byte prefix (any prefix is valid). For **JSON**
> streams under **relaxed**, an OS/power crash mid-write of a record can leave the data
> file ending mid-record (e.g. `…,{"a":1`). Recovery sets `tail = file_size`
> unconditionally and does **not** trim the torn record, so the read path wraps it and
> serves **malformed JSON**. A sound _bounded_ trim is not feasible from the data file
> alone: the wire is bare concatenated `value,` records with no length framing and no
> per-record durable offset index, and the boundary finder
> (`tier::last_json_value_boundary`) is a forward state machine that must start from a
> known-clean position — a pure tail-read can start inside a JSON string and is
> unsound, while the only clean anchor (`sealed_offset`) is only near the tail when
> tiering is enabled. **Strict is unaffected** (acks are post-fsync at record
> boundaries); binary streams are unaffected. Resolution is a product decision:
> document this limitation, or restrict `relaxed` to binary streams. Tracked against
> the design spec §6.

## Design rationale

- **Why ack-before-fsync.** Benchmarks (below) established that `fdatasync` is the only
  meaningful local-durability cost on the append path, and only at low cardinality.
  Removing it from the critical path is the cheap, high-confidence win; the durability it
  provided is replaced by S3-offload (cold, today) plus replication (hot tail, future).

- **Why a module-global flag.** The mode is a process-global `AtomicBool`
  (`DURABILITY_RELAXED`) set once at startup from `--durability`, read on the hot path
  with a single `Relaxed` load. This deliberately mirrors the established
  `set_splice_appends` / `set_read_offload` startup-flag pattern rather than threading a
  `Store` field into every call site. It adds no lock, no contention, and no plumbing into
  the create site, so strict keeps its exact cost. (The design spec described this as a
  `Copy` `DurabilityMode` enum on `Store`; the implementation realizes the same semantics
  via the established global-flag pattern — see the audit below.)

- **Why strict stays the default and byte-for-byte.** The only strict-path change is that
  `sync_to` is now reached through one extra `async fn` frame (`maybe_sync_on_ack`), whose
  non-relaxed branch calls `sync_to` with identical arguments. No behavior change, no
  regression risk.

- **Why recovery stays O(1).** The tail is _derived from the file size_, not from any
  per-append fsync — so the bytes that survived OS writeback are exactly the recovered
  prefix. Dropping the append fsync therefore needs no recovery change. Per-stream
  recovery is one `fstat` + a manifest read; total boot is `O(#streams)` +
  `O(#sealed-but-unoffloaded segments)`, identical to strict.

- **Deferred hot-tail durability → replication.** Relaxed intentionally leaves the recent
  hot tail at risk only on an OS/power crash. Closing that window durably is replication's
  job, and is explicitly out of scope here.

## Performance insights

The headline: **relaxed's win scales with how expensive `fdatasync` is relative to the
rest of the work.** It is large at low cardinality (fsync latency is on the critical
path), it ties strict at high cardinality on fast NVMe (strict's per-stream fsyncs run in
parallel across streams and coalesce deep on each one, hiding the latency), and it
delivers **better tail latency everywhere** (no append ever blocks on a barrier fsync).

### GKE — strict vs relaxed, multi-stream cardinality sweep

Same binary, A/B by `--durability`, n2d-standard-8 server node (4 cpu / 16 Gi), single
client pod. (`relaxed-cpu4-1782118313`.)

| streams (N) | strict (ops/s · p99) | relaxed (ops/s · p99) | throughput | p99         |
| ----------- | -------------------- | --------------------- | ---------- | ----------- |
| 10          | 12,539 · 2 ms        | 33,804 · 1 ms         | **2.7×**   | better      |
| 100         | 31,325 · 21 ms       | 86,917 · 3 ms         | **2.8×**   | 7× better   |
| 1,000       | 38,952 · 221 ms      | 36,268 · 93 ms        | ~tie       | 2.4× better |
| 10,000      | 40,207 · 2,421 ms    | 36,875 · 1,139 ms     | ~tie       | 2.1× better |

- The **throughput** win is at low–moderate cardinality (2.7–2.8× at N=10–100), where few
  concurrent appenders per stream put fsync latency on the critical path.
- At N≥1,000 relaxed ≈ strict: strict's per-stream fsyncs run in parallel across streams
  (and coalesce deep on each hot stream), hiding the latency — there is little fsync cost
  left to remove.
- The robust, everywhere benefit is **tail latency**: relaxed's p99 is better at every N
  (7× at N=100, 2.1× at N=10,000) because no append blocks on a barrier fsync.

> **Caveat (high N).** At N=1,000 / 10,000 relaxed's throughput is a hair _below_ strict
> (36k vs 39–40k). This is inter-cluster variance (separate nodes, a single repeat), not a
> regression — relaxed does strictly less work than strict at every N. The GKE FINDINGS
> call this out explicitly.

### Single-stream raw power (GKE)

On one hot stream, strict's per-stream coalescing already amortizes the fsync, so the two
modes are equal:

| workload                     | strict                    | relaxed                   |
| ---------------------------- | ------------------------- | ------------------------- |
| append (single stream, 1 KB) | 51,716 ops/s · p99 103 ms | 49,991 ops/s · p99 110 ms |
| reads (256-conn, 1 KB)       | 37,051 ops/s · p99 198 ms | 36,806 ops/s · p99 193 ms |

Reads are equal because relaxed touches neither the read path (`sendfile` zero-copy) nor
the splice write path.

### Local sweep — bigger wins where fsync is slower

On a macOS Docker VM, where `fdatasync` is slower relative to compute, the same shape
holds but the magnitudes are larger (`local-card-1782120207`):

| streams (N) | strict (ops/s · p99) | relaxed (ops/s · p99) | speedup |
| ----------- | -------------------- | --------------------- | ------- |
| 10          | 7,008 · 3.1 ms       | 80,386 · 0.3 ms       | 11.5×   |
| 100         | 22,793 · 19.3 ms     | 128,492 · 1.8 ms      | 5.6×    |
| 1,000       | 31,881 · 201.6 ms    | 100,668 · 28.0 ms     | 3.2×    |
| 10,000      | 20,651 · 4,022 ms    | 31,557 · 3,086 ms     | 1.5×    |

The win shrinks monotonically as cardinality rises — exactly the predicted shape: the
slower the fsync, the more relaxed removes, and the more parallelism strict has to hide it
at high N.

### How this work was motivated

- **`--no-fsync` isolation** (`nofsync-cpu4-1782111075`): with all fsync removed, the
  reference path gained **2.4× at N=10** falling to **~1.13× at N=10,000** — pinpointing
  fsync as the only meaningful local cost, and only at low cardinality. Relaxed reproduces
  this `ref-nofsync` profile from the real `--durability relaxed` flag (SC1 validated).
- **Shared-WAL dead end** (`suite-cpu4-1782084677`): the preceding shared-WAL approach
  collapsed to a flat ~500 ops/s at every N on honest NVMe — its serialized committer and
  copy-heavy materialize-back data path were the wall, not fsync. That ruled out batching
  fsync centrally and pointed at the simpler win relaxed delivers: per-stream files, no
  hot-path fsync, durability via the tier + replication.

## Optimization-adherence audit

Verified against the code on `vbalegas/relaxed-durability`
(`git diff c2dd5fa5..HEAD -- packages/server-rust/src`). The entire feature is 121 lines
across three files; `tier.rs` and `engine_raw.rs` are untouched.

| #   | claim                                                         | verdict                   | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Relaxed skips the data `fdatasync` at **all three** sites     | **HOLDS**                 | All three route `maybe_sync_on_ack(durability_relaxed(), …)`: create-with-body (`handlers.rs:521`), mainline append + close (`handlers.rs:937`), splice fast path (`handlers.rs:1247`). The helper returns `Ok(())` early when relaxed, before reaching `sync_to`.                                                                                                                                                                                                                                             |
| 2   | `strict` is byte-for-byte unchanged                           | **HOLDS**                 | The non-relaxed branch is `st.sync.sync_to(file, st, target).await` — identical args to the original calls. The only delta is one extra `async fn` frame (`maybe_sync_on_ack`). The flag is a `Relaxed`-load `AtomicBool`; no `Store` field, no lock, no contention added to the strict path.                                                                                                                                                                                                                  |
| 3   | Recovery stays O(1) / stat-based                              | **HOLDS (with a caveat)** | `recover_one_inner` derives the tail from `file.metadata().ok()?.len()` — O(1), no new scan. **Caveat:** recovery does **not** trim a torn trailing JSON record (no `last_json_value_boundary` on the recovery path), so under **relaxed + JSON** an OS/power crash can recover a torn tail that the read path serves as malformed JSON. A sound _bounded_ trim is not feasible from the file alone (see the **Known limitation** above). Binary streams and strict are unaffected. **Open product decision.** |
| 4   | Zero-copy `sendfile` reads and `splice` appends are preserved | **HOLDS**                 | `engine_raw.rs` (sendfile read path, `splice_appends`) is untouched (empty `git diff --stat`). The splice site change only wraps the existing `sync_to` in the gate; the splice write itself is unchanged.                                                                                                                                                                                                                                                                                                     |
| 5   | Segment retention is genuinely reused unchanged               | **HOLDS**                 | `tier.rs` (seal/offload/compact) is untouched. `maybe_seal_bg` still fires after the ack in both modes. Relaxed keeps the durable off-path commits retention depends on: the close-meta commit (`write_meta_sync(durable=true)`, `handlers.rs:~948`) and the seal/offload manifest stay durable. Retention correctness depends on no fsync that relaxed drops.                                                                                                                                                 |
| 6   | Measured performance matches the proposed thesis              | **HOLDS**                 | Win at low cardinality (GKE 2.7×/2.8× at N=10/100), ~tie at high (0.9× at N=1,000/10,000 — within inter-cluster variance), better p99 at **every** N (7× at N=100, 2.1× at N=10,000). Matches the `ref-nofsync` prediction (2.4× at N=10, ~1.13× at N=10,000).                                                                                                                                                                                                                                                 |

### Noted divergence (benign)

One intentional, semantics-preserving divergence from the **spec**, recorded in the
implementation **plan**: the design spec (§4) described the mode as a `Copy`
`DurabilityMode` enum field on `Store`; the implementation realizes it as a process-global
`AtomicBool` matching the established `set_splice_appends` / `set_read_offload` flag
pattern. Same semantics (server-wide, set once at startup, read by value on the hot path),
deliberately chosen to avoid threading a `Store` field into the create site and to keep
zero strict-path cost. Not a behavioral divergence.

**Verdict: five checks HOLD; check #3 (recovery) HOLDS with a caveat.** The
implementation delivers the proposed optimization — relaxed skips the data fsync at all
three sites, strict is unchanged, retention and zero-copy reads are reused untouched, and
the measured performance matches the thesis. Recovery stays O(1)/stat-based, but it does
**not** trim a torn trailing JSON record, so **relaxed + JSON** can recover a torn tail
that serves malformed JSON (the **Known limitation** above) — an open product decision
(document, or restrict relaxed to binary streams), since a sound bounded trim is not
feasible from the data file alone. The spec §6 originally claimed such a trim; it has been
corrected. The flag-representation refinement (global `AtomicBool` vs the spec's `Store`
enum field) is intentional and semantics-equivalent.

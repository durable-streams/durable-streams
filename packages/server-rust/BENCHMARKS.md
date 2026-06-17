# Benchmarks

This document describes the performance experiments we run against this server:
the run environment, how the measurements are set up, and an engine-level
comparison against [Ursula](https://github.com/tonbo-io/ursula), a Raft-based
durable-streams server.

These benchmarks are **tailored for the way this server is deployed** — a single
self-contained binary with a data directory, no broker or external database.
They emphasise the paths that deployment actually exercises: hot resident
catch-up reads (served zero-copy with `sendfile(2)`), group-commit append
throughput, and cold-tier offload. They are not a general database benchmark and
they are not tuned to flatter any particular shape of workload.

The full harness (server launch, cgroup pinning, load-generator scripts and
aggregation) is being prepared as a **separate, reproducible benchmark
repository** so the numbers below can be re-run end to end.

## Run environment

|                |                                                          |
| -------------- | -------------------------------------------------------- |
| Machine        | Dedicated Hetzner server                                 |
| CPU            | Intel Xeon E5-1650 v3 @ 3.50 GHz (6 cores / 12 threads)  |
| Memory         | 251 GB                                                   |
| OS             | Ubuntu 24.04, Linux kernel 6.8                           |
| CPU governor   | `performance` (pinned before each run for stable clocks) |
| Load generator | `wrk` (compiled, multi-threaded)                         |

## How it's set up

The goal is to measure _server_ cost with no contention from the load
generator, and to read CPU directly from the kernel rather than parsing `/proc`.

- **Server in its own cgroup.** Each server runs as a transient `systemd`
  service. That gives it a dedicated cgroup: `AllowedCPUs` (a cpuset) pins it to
  a fixed set of cores, `MemoryMax` bounds its page cache (so cold reads do real
  disk I/O), and `CPUUsageNSec` reports exact server CPU over the measurement
  window — no sampling.
- **Client on disjoint cores.** `wrk` is `taskset`-pinned to a _disjoint_ set of
  cores, so client and server never steal each other's CPU. On the 12-thread box
  the split is **server 0–7, client 8–10, with core 11 reserved** for the system
  and `sshd` (so a saturating run can never lock the box out).
- **Matched durability.** Both servers are configured as pure local-durable:
  this server with cold tiering off, Ursula as a single-node Raft group with a
  disk write-ahead log and no cold backend. So an append is _fsync versus fsync_
  and a read is _read versus read_.
- **Repeats.** Each cell runs 3 times; we report the median and the coefficient
  of variation (cv) across repeats.

## This server (raw engine)

Server cgroup-pinned to 8 cores, `wrk` on 3 disjoint cores, governor
`performance`.

**Reads** (conn 256):

| read size | throughput | server CPU |
| --------- | ---------- | ---------- |
| 1 KB      | 236k /s    | 508 %      |
| 16 KB     | 160k /s    | 456 %      |
| 1 MB      | 11.2k /s   | 266 %      |

**Read scaling by server cores** (1 KB, conn 256): 2c → **193k**, 4c → **256k**,
8c → 236k /s — scales until the 3-core load generator saturates past 4 server
cores.

**Appends** (100 B): 116k /s @ conn 64, **210k /s** @ conn 256 (group commit).
`--splice-appends` (1 MB binary): 375 → 404 /s at **76% → 43% CPU** (a CPU
lever, not a throughput one). Cold-tier read (`--tier local`): ~**5 GB/s**.

## Engine-level comparison: this server vs Ursula

Both servers run the _same_ binary-protocol shape — `PUT` a stream, `POST` raw
bytes, `GET` to read back — under the methodology above, pinned to the same 8
cores. Reads are catch-up `GET`s of a pre-seeded stream; appends are covered in
two ways (see open questions).

<!-- RESULTS:BEGIN -->

Median of 3 repeats; cv across repeats was < 1% for nearly every cell.

**Reads** — catch-up `GET` of a resident stream:

| size  | conn | this server | Ursula  | ratio | this CPU% | Ursula CPU% | this p99 | Ursula p99 |
| ----- | ---- | ----------- | ------- | ----- | --------- | ----------- | -------- | ---------- |
| 1 KB  | 16   | 216k /s     | 71k /s  | 3.05× | 474       | 493         | 0.09 ms  | 0.46 ms    |
| 1 KB  | 64   | 232k /s     | 88k /s  | 2.63× | 501       | 581         | 0.38 ms  | 1.36 ms    |
| 1 KB  | 256  | 236k /s     | 97k /s  | 2.42× | 509       | 643         | 1.12 ms  | 4.45 ms    |
| 1 KB  | 1024 | 240k /s     | 93k /s  | 2.58× | 541       | 668         | 6.44 ms  | 142 ms     |
| 16 KB | 256  | 160k /s     | 76k /s  | 2.11× | 456       | 615         | 1.63 ms  | 5.71 ms    |
| 1 MB  | 256  | 11.2k /s    | 6.1k /s | 1.83× | 269       | 584         | 22.3 ms  | 50.9 ms    |

This server serves reads at **1.8–3×** the throughput, and the gap is widest at
small sizes where the zero-copy `sendfile(2)` path matters most.

**Read scaling by server cores** (1 KB, conn 256) — the cleanest efficiency
view, because at 2 and 4 cores both servers use essentially the same CPU:

| server cores | this server | Ursula | ratio | this CPU% | Ursula CPU% |
| ------------ | ----------- | ------ | ----- | --------- | ----------- |
| 2 cores      | 203k /s     | 48k /s | 4.26× | 200       | 199         |
| 4 cores      | 258k /s     | 75k /s | 3.42× | 382       | 374         |
| 8 cores      | 235k /s     | 97k /s | 2.43× | 513       | 635         |

At an _equal CPU budget_ this server delivers **3–4×** the read throughput (its
own throughput plateaus at 8 cores only because the 3-core load generator
saturates first).

**Appends — concurrent single-record** (one `POST` per message, the
many-independent-producers case):

| conn | this server | Ursula | ratio | this CPU% | Ursula CPU% | this p99 | Ursula p99 |
| ---- | ----------- | ------ | ----- | --------- | ----------- | -------- | ---------- |
| 64   | 117k /s     | 553 /s | 211×  | 357       | 56          | 0.78 ms  | 144 ms     |
| 256  | 219k /s     | 478 /s | 458×  | 559       | 58          | 1.88 ms  | 833 ms     |

Here group commit dominates: this server folds the concurrent appends into shared
fsyncs, while Ursula commits roughly one fsync per request (~500/s, fsync-bound,
50-ms-plus latency). This is the workload group commit is built for; see the
bulk-ingest row for the amortised view.

**Appends — bulk ingest** (Ursula's `append-batch` of 512 records vs a single
equally-sized `POST` here — one fsync each, conn 16):

| batch       | this server            | Ursula                 | ratio | this CPU% | Ursula CPU% |
| ----------- | ---------------------- | ---------------------- | ----- | --------- | ----------- |
| 512 × 100 B | 287 MB/s (2.87M rec/s) | 180 MB/s (1.80M rec/s) | 1.59× | 58        | 159         |

Once fsync is amortised both servers ingest at hundreds of MB/s; this server is
**~1.6× faster at roughly a third of the CPU** (58% vs 159%).

<!-- RESULTS:END -->

## Open questions and caveats

These shape how the numbers should be read, and what we still want to measure:

- **Append model — single-record vs batched.** This server's high append
  throughput comes from _group commit_: concurrent independent producers'
  appends coalesce into one shared fsync. Ursula amortises fsync differently, via
  an explicit `append-batch` endpoint. We therefore report both a concurrent
  single-record append test and a fair bulk-ingest test (Ursula's batched append
  versus a single equally-sized append on our side — one fsync each).
- **Busy-poll vs parking runtime.** Ursula uses a thread-per-core runtime that
  spins; this server parks idle workers. This inflates Ursula's measured read
  CPU% relative to ours, so read CPU/operation for Ursula is likely overstated.
- **Single-stream vs multi-stream.** This study drives a single stream. Ursula
  is multi-Raft and is designed to scale throughput across many streams; a
  single-stream test does not exercise that. A multi-stream fan-out comparison is
  the next experiment.
- **Record framing vs raw bytes.** Ursula stores framed records; this server
  stores the literal wire bytes. Payload sizes are matched, but on-disk and
  on-wire framing differ slightly.
- **Cold tier not yet compared.** Both servers support an S3-compatible cold
  tier; a cross-implementation cold-read comparison (memory-capped, served from
  object storage) is not yet part of this suite.

# Design: Publish the Rust server and client to crates.io

**Date:** 2026-06-18
**Status:** Approved (brainstorming) — pending spec review
**Worktree/branch:** `worktree-publish-rust-crates` (branched from `vbalegas/streams-rust` HEAD)

## Background

Two Rust packages live in the monorepo and are not yet published to crates.io:

- `packages/server-rust` — a **binary** crate (the high-performance Durable Streams
  server). Currently named `durable-streams-server` v0.1.0.
- `packages/client-rust` — a **library** crate (the Rust client). Currently named
  `durable-streams` v0.1.0, with a test-only `conformance-adapter` binary.

The goal is to publish both so the server is `cargo install`-able and the client is
`cargo add`-able. This is the maintainer's first crates.io publish.

The maintainer is **concurrently refactoring the server source**, so this work must be
**merge-safe**: it touches only manifests / ignore files / a test script — **zero edits
to any `src/*.rs`** — so the two efforts rebase past each other cleanly.

## Goals

- Publish `packages/server-rust` as a binary crate (`cargo install …` runs the server).
- Publish `packages/client-rust` as a library crate (`cargo add …` for downstream use).
- Keep all changes confined to non-source files for merge safety.

## Non-goals (explicit follow-ups, not this effort)

- CI publish-on-tag automation (GitHub Action).
- Resolving the repo-wide license contradiction (see License section).
- Splitting the server into `lib` + `bin` — maintainer chose binary-only.
- Publishing any other package (Caddy plugin, TS packages, etc.).

## Key findings that shaped the design

1. **`durable-streams-server` is already taken** on crates.io by a third party
   (`thesampaton`, an independent axum-based implementation, versions up to 0.3.0).
   We cannot publish under that name.
2. **`durable-streams`, `durable-streams-client` are both free** on crates.io.
3. **The client crate already claims the bare name `durable-streams`** in its manifest.
   The chosen allocation is therefore a *swap*.
4. **License inconsistency exists repo-wide**: the root `LICENSE` file is MIT, but every
   package manifest (14+ incl. the TS client, TS server, Caddy plugin, CLI, and the Rust
   server) declares `Apache-2.0`. The lone Rust outlier is the client (`MIT OR Apache-2.0`).
   The project's *intended* license is clearly Apache-2.0; the MIT `LICENSE` file is the
   stray. **Decision: do not touch the repo base LICENSE in this effort.**
5. **Client `target/` is committed to git** (force-added; root `.gitignore` line 186 already
   ignores `target/`). cargo auto-excludes `target/` from the package, so it does not ship,
   but it is repo bloat worth untracking.
6. **Client `base64` is a normal dependency used only by the `conformance-adapter` bin** —
   so every library consumer compiles `base64` for nothing.
7. **No `test:run:rust` script is wired into the conformance runner** (only elixir/python
   are). The rust adapter is run manually via `run-conformance-adapter.sh`, which execs a
   pre-built `target/release/conformance-adapter`.

## Decisions

### Naming

| Package | Current name | New name | Kind | Entry point |
|---|---|---|---|---|
| `packages/server-rust` | `durable-streams-server` (taken) | **`durable-streams`** | binary | `cargo install durable-streams` → command `durable-streams` |
| `packages/client-rust` | `durable-streams` | **`durable-streams-client`** | library | `cargo add durable-streams-client` |

- The server's installed **command** stays `durable-streams` (default = crate name; no
  `[[bin]]` override). Confirmed by maintainer.
- Allocating the bare name to the binary is slightly unconventional (the bare name is
  usually a library) but is a deliberate, maintainer-confirmed choice.

### License

- Root `LICENSE` file (MIT): **untouched**. The repo-wide MIT-vs-Apache contradiction is
  explicitly deferred.
- Server: `license = "Apache-2.0"` — **no change** (already correct).
- Client: `license = "MIT OR Apache-2.0"` → **`"Apache-2.0"`** (match the rest of the repo).
- **No `LICENSE` file copied into the crate dirs.** Copying the root MIT text would
  contradict the `Apache-2.0` SPDX field; cargo only needs the `license =` field to publish.
  The pre-existing repo-level contradiction is documented and deferred.

### Scope

Both crates are prepared and published in this effort. They do not depend on each other, so
publish order is irrelevant.

## Detailed changes (all non-source)

### A. `packages/server-rust/Cargo.toml`

- `name = "durable-streams-server"` → `name = "durable-streams"`
- Add `keywords = ["durable-streams", "streaming", "event-sourcing", "http", "append-only-log"]`
  (5 max, each ≤20 chars — valid).
- Add `categories = ["network-programming", "web-programming::http-server"]` (valid crates.io
  category slugs).
- Add `exclude = ["conformance"]` (drop the 8 KB of TypeScript conformance tests from the
  package). Keep `README.md`, `ARCHITECTURE.md`, `BENCHMARKS.md` (README links to
  `./BENCHMARKS.md`).
- `license`, `description`, `repository`, `homepage`, `readme`, `rust-version` unchanged.

### B. `packages/client-rust/Cargo.toml`

- `name = "durable-streams"` → `name = "durable-streams-client"`
- `license = "MIT OR Apache-2.0"` → `license = "Apache-2.0"`
- `base64 = "0.22"` → `base64 = { version = "0.22", optional = true }`
- `[features]`: add `conformance = ["dep:base64"]`
- `[[bin]] conformance-adapter`: add `required-features = ["conformance"]`
- Add `exclude = ["design.md", "run-conformance-adapter.sh"]`

Result: the published library pulls **no** `base64` and builds **no** stray binary; the
adapter binary builds only under `--features conformance`.

### C. `packages/client-rust/run-conformance-adapter.sh`

Update so the conformance flow still works with the now-gated bin: build with the feature
before exec'ing.

```bash
#!/bin/bash
cd "$(dirname "$0")"
cargo build --release --features conformance --bin conformance-adapter >&2
exec ./target/release/conformance-adapter
```

(This script is excluded from the published package, so it does not affect the crate.)

### D. Untrack the client `target/`

`git rm -r --cached packages/client-rust/target` — the root `.gitignore` already ignores
`target/`, so no new ignore file is needed.

## Verification

In the worktree, before any publish:

1. `cargo build --release` in `packages/server-rust` — clean build.
2. `cargo build --release` in `packages/client-rust` (default features) — clean, and
   confirms `base64`/the bin are **not** built by default.
3. `cargo build --release --features conformance --bin conformance-adapter` in the client —
   the gated bin still compiles.
4. `cargo package --list` in each crate — confirm the exact shipped file set
   (server excludes `conformance/`; client excludes `design.md`,
   `run-conformance-adapter.sh`, and `target/`).
5. `cargo publish --dry-run` in each crate — passes (uploads nothing).

## Publish runbook (who does what)

**Me (in the worktree):** all edits A–D above; run the full Verification list; report the
`cargo package --list` and `--dry-run` output.

**Maintainer (account & secrets — cannot/should not be automated):**
1. Sign in to crates.io with GitHub.
2. **Verify account email** (required before any publish).
3. Generate a scoped API token (Account Settings → API Tokens; scope to publish-new +
   publish-update; optionally restrict to the two crate names).
4. `cargo login` (or export `CARGO_REGISTRY_TOKEN`).

**Final publish** (irreversible & public): `cargo publish` per crate, run by the maintainer
(or explicitly authorized after login). Optionally `cargo owner --add <org/team>` afterward
for shared ownership.

## Merge-safety summary

Files touched: `packages/server-rust/Cargo.toml`, `packages/client-rust/Cargo.toml`,
`packages/client-rust/run-conformance-adapter.sh`, and untracking
`packages/client-rust/target/`. **No `src/*.rs` is modified**, so the maintainer's parallel
server refactor and this work are disjoint and rebase cleanly.
